/**
 * Kubernetes CRD informer layer.
 *
 * Watches NanoAgent / NanoMessagingGroup / NanoWiring custom resources
 * and maintains an in-memory cache. Replaces the SQLite reads of
 * `agent_groups`, `messaging_groups`, `messaging_group_agents` when
 * NANOCLAW_CONFIG_SOURCE=crd.
 *
 * Design:
 *   - List once at startup to seed the cache.
 *   - Watch with resourceVersion + reconnect on disconnect (k8s-style).
 *   - Cache is a Map keyed by metadata.name (namespace is fixed via env).
 *   - Notify listeners on add/update/delete (for invalidating downstream
 *     caches like the wire-cache in router.ts).
 *
 * The informers don't validate spec shape — that's the API server's job.
 * Bad specs surface as runtime errors when consumers read them.
 */
import * as k8s from '@kubernetes/client-node';

import { log } from '../log.js';

export type CrdEventType = 'ADDED' | 'MODIFIED' | 'DELETED';

export interface CrdResource {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
    uid?: string;
    resourceVersion?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec?: Record<string, unknown>;
  status?: Record<string, unknown>;
}

export interface InformerConfig {
  group: string;
  version: string;
  plural: string;
  namespace?: string; // undefined = cluster-scoped
}

type Listener<T extends CrdResource> = (event: CrdEventType, obj: T) => void;

export class CrdInformer<T extends CrdResource = CrdResource> {
  private readonly cache = new Map<string, T>();
  private readonly listeners: Listener<T>[] = [];
  private request?: { abort: () => void };
  private stopped = false;

  constructor(
    private readonly kc: k8s.KubeConfig,
    private readonly cfg: InformerConfig,
  ) {}

  get(name: string): T | undefined {
    return this.cache.get(name);
  }

  list(): T[] {
    return Array.from(this.cache.values());
  }

  on(fn: Listener<T>): void {
    this.listeners.push(fn);
  }

  async start(): Promise<void> {
    await this.listAndSeed();
    this.watch().catch((err) => {
      if (!this.stopped) log.error('CRD watch terminated unexpectedly', { plural: this.cfg.plural, err: String(err) });
    });
  }

  stop(): void {
    this.stopped = true;
    this.request?.abort();
  }

  // ─────────────────────────── internals ───────────────────────────

  private async listAndSeed(): Promise<void> {
    const api = this.kc.makeApiClient(k8s.CustomObjectsApi);
    const res = this.cfg.namespace
      ? await api.listNamespacedCustomObject(this.cfg.group, this.cfg.version, this.cfg.namespace, this.cfg.plural)
      : await api.listClusterCustomObject(this.cfg.group, this.cfg.version, this.cfg.plural);
    const body =
      (res as unknown as { body?: { items?: T[] }; items?: T[] }).body ?? (res as unknown as { items?: T[] });
    for (const item of body.items ?? []) {
      this.cache.set(item.metadata.name, item);
    }
    log.info('CRD informer seeded', {
      plural: this.cfg.plural,
      count: this.cache.size,
    });
  }

  private async watch(): Promise<void> {
    const watcher = new k8s.Watch(this.kc);
    const url = this.cfg.namespace
      ? `/apis/${this.cfg.group}/${this.cfg.version}/namespaces/${this.cfg.namespace}/${this.cfg.plural}`
      : `/apis/${this.cfg.group}/${this.cfg.version}/${this.cfg.plural}`;
    while (!this.stopped) {
      try {
        await new Promise<void>((resolve, reject) => {
          watcher
            .watch(
              url,
              {},
              (type: string, obj: T) => this.handleEvent(type as CrdEventType, obj),
              (err) => {
                if (err) reject(err);
                else resolve();
              },
            )
            .then((req) => {
              this.request = req;
            })
            .catch(reject);
        });
      } catch (err) {
        if (this.stopped) return;
        log.warn('CRD watch error, reconnecting', { plural: this.cfg.plural, err: String(err) });
      }
      if (!this.stopped) await new Promise((r) => setTimeout(r, 1000));
    }
  }

  private handleEvent(type: CrdEventType, obj: T): void {
    const name = obj.metadata?.name;
    if (!name) return;
    if (type === 'DELETED') this.cache.delete(name);
    else this.cache.set(name, obj);
    for (const fn of this.listeners) {
      try {
        fn(type, obj);
      } catch (err) {
        log.error('CRD listener threw', { plural: this.cfg.plural, err: String(err) });
      }
    }
  }
}

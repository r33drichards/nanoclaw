/**
 * Typed NanoClaw CRD informers + projection helpers.
 *
 * The informer cache stores raw CRDs; the projection helpers shape them
 * into the existing TS types the host code already consumes
 * (`AgentGroup`, `MessagingGroup`, `MessagingGroupAgent`, etc.), so
 * downstream code that branches on `getBackend()` / `getConfigSource()`
 * sees the same row shapes regardless of source.
 */
import * as k8s from '@kubernetes/client-node';

import { log } from '../log.js';
import type { AgentGroup, MessagingGroup, MessagingGroupAgent } from '../types.js';

import { CrdInformer, type CrdResource } from './informer.js';

export interface NanoAgentResource extends CrdResource {
  spec?: {
    displayName?: string;
    provider: string;
    model?: string;
    effort?: string;
    assistantName?: string;
    maxMessagesPerPrompt?: number;
    imageTag?: string;
    cliScope?: string;
    skills?: string | string[];
    packages?: { apt?: string[]; npm?: string[] };
    mcpServers?: Record<
      string,
      { command: string; args?: string[]; env?: Record<string, string>; instructions?: string }
    >;
    additionalMounts?: Array<{ hostPath?: string; containerPath: string; readonly?: boolean }>;
    destinations?: Array<{
      name: string;
      displayName?: string;
      type: string;
      channelType?: string;
      platformId?: string;
      agentRef?: string;
    }>;
    members?: string[];
    warmPool?: { replicas?: number };
    allowedEgress?: string[];
  };
}

export interface NanoMessagingGroupResource extends CrdResource {
  spec?: {
    channelType: string;
    platformId: string;
    name?: string;
    isGroup?: boolean;
    unknownSenderPolicy?: 'strict' | 'request_approval' | 'public';
  };
}

export interface NanoWiringResource extends CrdResource {
  spec?: {
    messagingGroupRef: string;
    agentRef: string;
    sessionMode?: 'shared' | 'per-thread' | 'agent-shared';
    engageMode?: 'pattern' | 'mention' | 'mention-sticky';
    engagePattern?: string;
    senderScope?: 'all' | 'known';
    ignoredMessagePolicy?: 'accumulate' | 'drop';
    priority?: number;
  };
}

let _agents: CrdInformer<NanoAgentResource> | null = null;
let _messagingGroups: CrdInformer<NanoMessagingGroupResource> | null = null;
let _wirings: CrdInformer<NanoWiringResource> | null = null;

export interface CrdInformersOptions {
  namespace?: string;
  kubeconfig?: string;
}

export async function startCrdInformers(opts: CrdInformersOptions = {}): Promise<void> {
  const kc = new k8s.KubeConfig();
  if (opts.kubeconfig) kc.loadFromFile(opts.kubeconfig);
  else kc.loadFromDefault();
  const namespace = opts.namespace ?? process.env.NANOCLAW_NAMESPACE ?? 'default';

  _agents = new CrdInformer(kc, {
    group: 'nanoclaw.io',
    version: 'v1alpha1',
    plural: 'nanoagents',
    namespace,
  });
  _messagingGroups = new CrdInformer(kc, {
    group: 'nanoclaw.io',
    version: 'v1alpha1',
    plural: 'nanomessaginggroups',
    namespace,
  });
  _wirings = new CrdInformer(kc, {
    group: 'nanoclaw.io',
    version: 'v1alpha1',
    plural: 'nanowirings',
    namespace,
  });

  await Promise.all([_agents.start(), _messagingGroups.start(), _wirings.start()]);
  log.info('CRD informers started', { namespace });
}

export function stopCrdInformers(): void {
  _agents?.stop();
  _messagingGroups?.stop();
  _wirings?.stop();
  _agents = _messagingGroups = _wirings = null;
}

export function getAgentInformer(): CrdInformer<NanoAgentResource> {
  if (!_agents) throw new Error('CRD informers not started. Call startCrdInformers() first.');
  return _agents;
}

export function getMessagingGroupInformer(): CrdInformer<NanoMessagingGroupResource> {
  if (!_messagingGroups) throw new Error('CRD informers not started.');
  return _messagingGroups;
}

export function getWiringInformer(): CrdInformer<NanoWiringResource> {
  if (!_wirings) throw new Error('CRD informers not started.');
  return _wirings;
}

// ─────────────────── projections to existing TS types ───────────────────

export function projectAgentGroup(a: NanoAgentResource): AgentGroup {
  return {
    id: a.metadata.name,
    name: a.spec?.displayName ?? a.spec?.assistantName ?? a.metadata.name,
    folder: a.metadata.name, // declarative mode reuses name as folder slug
    agent_provider: a.spec?.provider ?? null,
    created_at: a.metadata.annotations?.['nanoclaw.io/created-at'] ?? new Date(0).toISOString(),
  };
}

export function projectMessagingGroup(m: NanoMessagingGroupResource): MessagingGroup {
  return {
    id: m.metadata.name,
    channel_type: m.spec?.channelType ?? '',
    platform_id: m.spec?.platformId ?? '',
    name: m.spec?.name ?? null,
    is_group: m.spec?.isGroup ? 1 : 0,
    unknown_sender_policy: m.spec?.unknownSenderPolicy ?? 'strict',
    denied_at: null,
    created_at: m.metadata.annotations?.['nanoclaw.io/created-at'] ?? new Date(0).toISOString(),
  };
}

export function projectWiring(w: NanoWiringResource): MessagingGroupAgent {
  return {
    id: w.metadata.name,
    messaging_group_id: w.spec?.messagingGroupRef ?? '',
    agent_group_id: w.spec?.agentRef ?? '',
    engage_mode: w.spec?.engageMode ?? 'mention',
    engage_pattern: w.spec?.engagePattern ?? null,
    sender_scope: w.spec?.senderScope ?? 'all',
    ignored_message_policy: w.spec?.ignoredMessagePolicy ?? 'accumulate',
    session_mode: w.spec?.sessionMode ?? 'shared',
    priority: w.spec?.priority ?? 0,
    created_at: w.metadata.annotations?.['nanoclaw.io/created-at'] ?? new Date(0).toISOString(),
  };
}

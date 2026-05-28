import { getAgentInformer } from '../crds/index.js';
import type { ContainerConfigRow } from '../types.js';

import { isCrdConfig } from './backend.js';
import { getDb } from './connection.js';

const SCALAR_COLUMNS = new Set([
  'provider',
  'model',
  'effort',
  'image_tag',
  'assistant_name',
  'max_messages_per_prompt',
  'cli_scope',
]);
const JSON_COLUMNS = new Set(['skills', 'mcp_servers', 'packages_apt', 'packages_npm', 'additional_mounts']);

/** Project a NanoAgent CR into the legacy ContainerConfigRow shape. */
function containerConfigFromCrd(agentGroupId: string): ContainerConfigRow | undefined {
  const a = getAgentInformer().get(agentGroupId);
  if (!a) return undefined;
  const s: NonNullable<typeof a.spec> = a.spec ?? ({ provider: 'claude' } as NonNullable<typeof a.spec>);
  return {
    agent_group_id: agentGroupId,
    provider: s.provider ?? null,
    model: s.model ?? null,
    effort: s.effort ?? null,
    image_tag: s.imageTag ?? null,
    assistant_name: s.assistantName ?? null,
    max_messages_per_prompt: s.maxMessagesPerPrompt ?? null,
    cli_scope: s.cliScope ?? 'group',
    skills: typeof s.skills === 'string' ? `"${s.skills}"` : JSON.stringify(s.skills ?? 'all'),
    mcp_servers: JSON.stringify(s.mcpServers ?? {}),
    packages_apt: JSON.stringify(s.packages?.apt ?? []),
    packages_npm: JSON.stringify(s.packages?.npm ?? []),
    additional_mounts: JSON.stringify(s.additionalMounts ?? []),
    updated_at: a.metadata.annotations?.['nanoclaw.io/updated-at'] ?? new Date(0).toISOString(),
  };
}

export function getContainerConfig(agentGroupId: string): ContainerConfigRow | undefined {
  if (isCrdConfig()) return containerConfigFromCrd(agentGroupId);
  return getDb().prepare('SELECT * FROM container_configs WHERE agent_group_id = ?').get(agentGroupId) as
    | ContainerConfigRow
    | undefined;
}

export function getAllContainerConfigs(): ContainerConfigRow[] {
  if (isCrdConfig()) {
    return getAgentInformer()
      .list()
      .map((a) => containerConfigFromCrd(a.metadata.name))
      .filter((c): c is ContainerConfigRow => c !== undefined);
  }
  return getDb().prepare('SELECT * FROM container_configs').all() as ContainerConfigRow[];
}

/** Insert a new config row. Caller must supply all JSON fields (use defaults for empty). */
export function createContainerConfig(config: ContainerConfigRow): void {
  getDb()
    .prepare(
      `INSERT INTO container_configs (
        agent_group_id, provider, model, effort, image_tag, assistant_name,
        max_messages_per_prompt, skills, mcp_servers, packages_apt, packages_npm,
        additional_mounts, updated_at
      ) VALUES (
        @agent_group_id, @provider, @model, @effort, @image_tag, @assistant_name,
        @max_messages_per_prompt, @skills, @mcp_servers, @packages_apt, @packages_npm,
        @additional_mounts, @updated_at
      )`,
    )
    .run(config);
}

/** Create an empty config row with sensible defaults. Idempotent — no-ops if row exists. */
export function ensureContainerConfig(agentGroupId: string): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO container_configs (agent_group_id, updated_at)
       VALUES (?, ?)`,
    )
    .run(agentGroupId, new Date().toISOString());
}

/** Update scalar fields on a config row. Only touches fields present in `updates`. */
export function updateContainerConfigScalars(
  agentGroupId: string,
  updates: Partial<
    Pick<
      ContainerConfigRow,
      'provider' | 'model' | 'effort' | 'image_tag' | 'assistant_name' | 'max_messages_per_prompt' | 'cli_scope'
    >
  >,
): void {
  const fields: string[] = [];
  const values: Record<string, unknown> = { agent_group_id: agentGroupId };

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      if (!SCALAR_COLUMNS.has(key)) throw new Error(`Invalid scalar column: ${key}`);
      fields.push(`${key} = @${key}`);
      values[key] = value;
    }
  }
  if (fields.length === 0) return;

  fields.push('updated_at = @updated_at');
  values.updated_at = new Date().toISOString();

  getDb()
    .prepare(`UPDATE container_configs SET ${fields.join(', ')} WHERE agent_group_id = @agent_group_id`)
    .run(values);
}

/** Overwrite a JSON column wholesale. Used for skills, mcp_servers, packages_*, additional_mounts. */
export function updateContainerConfigJson(
  agentGroupId: string,
  column: 'skills' | 'mcp_servers' | 'packages_apt' | 'packages_npm' | 'additional_mounts',
  value: unknown,
): void {
  if (!JSON_COLUMNS.has(column)) throw new Error(`Invalid JSON column: ${column}`);
  const now = new Date().toISOString();
  getDb()
    .prepare(`UPDATE container_configs SET ${column} = ?, updated_at = ? WHERE agent_group_id = ?`)
    .run(JSON.stringify(value), now, agentGroupId);
}

export function deleteContainerConfig(agentGroupId: string): void {
  getDb().prepare('DELETE FROM container_configs WHERE agent_group_id = ?').run(agentGroupId);
}

import { DEFAULT_AGENT_PIPELINE } from '@engine/types';
import { getAgentSettings, type AgentDefaultsLayer } from '../stores/agent-settings';
import { buildApiEndpoints, resolveAgentEndpoint } from './endpoint-resolver';

export interface ReadinessIssue {
  message: string;
  section: 'api' | 'agent';
  blocking: boolean;
}

/** Local configuration checks only; this does not contact or choose a provider. */
export function checkJourneyReadiness(
  settings: { apiPool?: readonly unknown[]; agents?: unknown },
  defaults: AgentDefaultsLayer,
  plotMode: string,
): ReadinessIssue[] {
  const apiPool = buildApiEndpoints(settings.apiPool ?? []);
  if (!apiPool.length)
    return [
      { message: '尚未配置 API，请添加服务地址并选择模型。', section: 'api', blocking: true },
    ];
  const issues: ReadinessIssue[] = [];
  const agentIds = DEFAULT_AGENT_PIPELINE.stages.flatMap((stage) => stage.agents);
  for (const id of agentIds) {
    const resolution = resolveAgentEndpoint({
      boundPoolId: getAgentSettings(settings, id, defaults).model,
      apiPool,
    });
    if (resolution.status === 'stale-binding') {
      issues.push({
        message: `${id} 绑定的 API 已不存在，请重新选择。`,
        section: 'agent',
        blocking: true,
      });
      continue;
    }
    if (plotMode === 'off' && id.startsWith('plot_')) continue;
    if (resolution.status !== 'resolved') continue;
    const endpoint = resolution.endpoint;
    const blocking = DEFAULT_AGENT_PIPELINE.requiredAgents?.includes(id) ?? false;
    let problem = '';
    try {
      const url = new URL(endpoint.baseUrl);
      if (!['http:', 'https:'].includes(url.protocol)) problem = '服务地址需要使用 http 或 https';
    } catch {
      problem = '尚未填写有效的服务地址';
    }
    if (!problem && !endpoint.defaultModel.trim()) problem = '尚未选择模型';
    if (
      !problem &&
      (endpoint.provider === 'image' ||
        (id !== 'memory_recall' && endpoint.provider === 'embedding'))
    ) {
      problem = '需要选择对话 API';
    }
    if (problem) issues.push({ message: `${id}：${problem}。`, section: 'api', blocking });
  }
  return issues;
}

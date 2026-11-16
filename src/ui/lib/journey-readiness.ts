import { isDirectMode } from '@engine/story/generation-mode';
import { DEFAULT_AGENT_PIPELINE } from '@engine/types/types';
import { getAgentSettings, type AgentDefaultsLayer } from '../stores/agent-settings';
import { agentDisplayName, DIRECT_MODE_AGENT_IDS } from './agent-roster';
import { buildApiEndpoints, resolveAgentEndpoint } from './endpoint-resolver';

export interface ReadinessIssue {
  message: string;
  /** 处理入口所在的设置分区；没有对应入口（如「尚未选择生成模式」在本页就地处理）时省略 */
  section?: 'api' | 'agent';
  blocking: boolean;
}

const MODE_MISSING_ISSUE: ReadinessIssue = { message: '尚未选择生成模式。', blocking: true };

/** Local configuration checks only; this does not contact or choose a provider. */
export function checkJourneyReadiness(
  settings: { apiPool?: readonly unknown[]; agents?: unknown },
  defaults: AgentDefaultsLayer,
  plotMode: string,
  generationMode: import('@engine/story/generation-mode').GenerationMode | '' = 'agent',
): ReadinessIssue[] {
  const rawPool = settings.apiPool ?? [];
  const apiPool = buildApiEndpoints(rawPool);
  // 未选模式时不知道要查哪组 Agent：只报模式本身 + 池级问题，逐 Agent 检查等选定后再做
  const modeIssues = generationMode === '' ? [MODE_MISSING_ISSUE] : [];
  if (!apiPool.length) {
    if (rawPool.length > 0) {
      return [
        ...modeIssues,
        {
          message: `${agentDisplayName('story')}：需要选择对话 API。`,
          section: 'api',
          blocking: true,
        },
      ];
    }
    return [
      ...modeIssues,
      { message: '尚未配置 API，请添加服务地址并选择模型。', section: 'api', blocking: true },
    ];
  }
  if (generationMode === '') return modeIssues;
  const issues: ReadinessIssue[] = [];
  const agentIds = isDirectMode(generationMode)
    ? DIRECT_MODE_AGENT_IDS
    : DEFAULT_AGENT_PIPELINE.stages.flatMap((stage) => stage.agents);
  for (const id of agentIds) {
    // 缓存直出仍执行 direct_main，但连接配置读 direct_cached；提示要指向实际检查的配置
    const profileId =
      id === 'direct_main' && generationMode === 'direct_cached' ? 'direct_cached' : id;
    const resolution = resolveAgentEndpoint({
      boundPoolId: getAgentSettings(settings, profileId, defaults).model,
      apiPool,
    });
    if (resolution.status === 'stale-binding') {
      issues.push({
        message: `${agentDisplayName(profileId)} 绑定的 API 已不存在，请重新选择。`,
        section: 'agent',
        blocking: true,
      });
      continue;
    }
    if (plotMode === 'off' && id.startsWith('plot_')) continue;
    if (resolution.status !== 'resolved') continue;
    const endpoint = resolution.endpoint;
    const blocking =
      id === 'direct_main' || (DEFAULT_AGENT_PIPELINE.requiredAgents?.includes(id) ?? false);
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
    if (problem) {
      issues.push({
        message: `${agentDisplayName(profileId)}：${problem}。`,
        section: 'api',
        blocking,
      });
    }
  }
  return issues;
}

import { describe, expect, it } from 'vitest';
import { checkJourneyReadiness } from '../../../src/ui/lib/journey-readiness';

const endpoint = {
  id: 'chat',
  name: 'Local',
  baseUrl: 'http://localhost:1234/v1',
  model: 'local-model',
  apiType: 'chat',
};

describe('journey readiness', () => {
  it('blocks an empty API pool before creation', () => {
    expect(checkJourneyReadiness({ apiPool: [] }, {}, 'off')).toEqual([
      expect.objectContaining({ blocking: true, section: 'api' }),
    ]);
  });
  it('accepts one default chat endpoint without requiring a key, image provider or embedding provider', () => {
    expect(checkJourneyReadiness({ apiPool: [endpoint] }, {}, 'off')).toEqual([]);
  });
  it.each([{ model: '' }, { baseUrl: '' }, { apiType: 'embedding' }])(
    'blocks unusable story configuration: %j',
    (invalid) => {
      expect(
        checkJourneyReadiness({ apiPool: [{ ...endpoint, ...invalid }] }, {}, 'off'),
      ).toContainEqual(
        expect.objectContaining({ blocking: true, message: expect.stringContaining('story') }),
      );
    },
  );
  it('uses project defaults and preserves explicit stale bindings', () => {
    expect(
      checkJourneyReadiness({ apiPool: [endpoint] }, { story: { model: 'deleted' } }, 'off'),
    ).toContainEqual(expect.objectContaining({ blocking: true, section: 'agent' }));
    expect(
      checkJourneyReadiness(
        { apiPool: [endpoint], agents: { story: { model: 'chat' } } },
        { story: { model: 'deleted' } },
        'off',
      ),
    ).toEqual([]);
  });
  it('names the cached profile when a cached direct save has a stale binding', () => {
    const issues = checkJourneyReadiness(
      {
        apiPool: [endpoint],
        agents: { direct_main: { model: 'chat' }, direct_cached: { model: 'deleted' } },
      },
      {},
      'off',
      'direct_cached',
    );
    expect(issues).toEqual([
      expect.objectContaining({
        blocking: true,
        section: 'agent',
        message: expect.stringContaining('direct_cached'),
      }),
    ]);
    expect(issues[0].message).not.toContain('direct_main');
  });
  it('names the cached profile when the cached binding has no model', () => {
    const issues = checkJourneyReadiness(
      {
        apiPool: [endpoint, { ...endpoint, id: 'cached', model: '' }],
        agents: { direct_main: { model: 'chat' }, direct_cached: { model: 'cached' } },
      },
      {},
      'off',
      'direct_cached',
    );
    expect(issues).toEqual([
      expect.objectContaining({ blocking: true, message: 'direct_cached：尚未选择模型。' }),
    ]);
  });
  it('keeps optional helpers nonblocking when their model is empty', () => {
    const issues = checkJourneyReadiness(
      {
        apiPool: [endpoint, { ...endpoint, id: 'optional', model: '' }],
        agents: { memory_summary: { model: 'optional' } },
      },
      {},
      'off',
    );
    expect(issues).toEqual([expect.objectContaining({ blocking: false })]);
  });
});

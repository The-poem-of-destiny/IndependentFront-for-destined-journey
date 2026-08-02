import { describe, expect, it } from 'vitest';
import { buildHonoApp, OPAQUE_ORIGIN_ERROR } from '../server/app';

describe('BFF origin boundary', () => {
  it('rejects requests from opaque sandbox origins before routing', async () => {
    const response = await buildHonoApp().request('/api/status', {
      headers: { Origin: 'null' },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: OPAQUE_ORIGIN_ERROR });
  });

  it('keeps ordinary app origins working', async () => {
    const response = await buildHonoApp().request('/api/status', {
      headers: { Origin: 'http://localhost:5173' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, service: 'fated-poem-bff' });
  });
});

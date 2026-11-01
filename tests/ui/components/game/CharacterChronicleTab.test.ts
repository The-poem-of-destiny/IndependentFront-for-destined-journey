// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { clearAllData, getDatabase, initializeDatabase } from '@engine/persistence/database';
import { createDefaultCharacterState } from '@engine/types/types';
import { turnChronicle } from '@engine/character/character-chronicle';
import CharacterChronicleTab from '../../../../src/ui/components/game/CharacterChronicleTab.vue';

const character = createDefaultCharacterState({ id: 'c1', saveId: 's1', name: '向导' });
beforeEach(async () => {
  await initializeDatabase();
  await clearAllData();
});

describe('character chronicle tab', () => {
  it('shows low importance history, filters/searches and exposes source details; switching characters resets', async () => {
    await getDatabase().characterChronicle.bulkPut(
      turnChronicle({
        character,
        source: { sourceTurnKey: 'u1', sourceMessageIds: ['a1'] },
        sourceText: '向导在渡口闲聊，然后答应同行。',
        createdAt: 1,
        gameTime: null,
        update: {
          name: character.name,
          profile_changes: {},
          chronicle: [
            {
              title: '闲聊',
              summary: '与旅人闲聊。',
              importance: 1,
              time: { kind: 'this_turn' },
              location: '渡口',
            },
            {
              title: '同行之约',
              summary: '承诺共同旅行。',
              importance: 9,
              time: { kind: 'this_turn' },
              impact: '建立长期约定',
            },
          ],
        },
      }),
    );
    const wrapper = mount(CharacterChronicleTab, { props: { character } });
    try {
      await vi.waitFor(() => expect(wrapper.findAll('li')).toHaveLength(2));
      await wrapper.findAll('button')[1].trigger('click');
      expect(wrapper.findAll('li')).toHaveLength(1);
      expect(wrapper.text()).toContain('同行之约');
      expect(wrapper.find('details').text()).toContain('建立长期约定');
      expect(wrapper.find('details').text()).toContain('向导在渡口闲聊');
      await wrapper.findAll('button')[0].trigger('click');
      await wrapper.find('input').setValue('渡口');
      expect(wrapper.findAll('li')).toHaveLength(1);
      expect(wrapper.find('li').text()).toContain('闲聊');
      await wrapper.find('input').setValue('不存在的地点');
      expect(wrapper.text()).toContain('没有符合条件的经历');
      await wrapper.setProps({ character: { ...character, id: 'c2', saveId: 's2' } });
      await vi.waitFor(() => expect(wrapper.text()).toContain('尚无经历记录'));
      expect(wrapper.find('input').element.value).toBe('');
    } finally {
      wrapper.unmount();
    }
  });
});

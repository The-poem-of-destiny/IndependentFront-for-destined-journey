/* global host */
/**
 * 杂货铺示例插件（插件系统设计 §7）。
 *
 * 只用帧内全局 `host`：
 * - `host.assets.readText('stock.json')` 读包内货架；
 * - `host.read('player')` + `host.subscribe('player', …)` 显示余额；
 * - `host.storage.save` 记限量货品已售数量（随存档，回退时跟着回退）；
 * - `host.commit({ commands })` 一次提交「扣钱 + 发物品」，余额不足时宿主返回
 *   `PRECONDITION_FAILED`，什么都不落，这里显示「金钱不足」；
 * - 成功后 `host.ai.note(…)` 让下一轮叙事知道这次购买（可选）。
 */
(function () {
  'use strict';

  var balanceEl = document.getElementById('balance');
  var stockEl = document.getElementById('stock');
  var noticeEl = document.getElementById('notice');
  var SOLD_KEY = 'sold';
  var sold = {};
  var busy = false;

  function notice(text, kind) {
    noticeEl.textContent = text;
    noticeEl.setAttribute('data-kind', kind || 'info');
  }

  function showBalance(player) {
    var money = player && typeof player.money === 'number' ? player.money : 0;
    balanceEl.textContent = money + ' G';
  }

  function remaining(entry) {
    if (typeof entry.limit !== 'number') return null;
    return Math.max(0, entry.limit - (sold[entry.id] || 0));
  }

  /** 按货架条目拼本次提交的命令批次（与 e2e 测试里的批次同形） */
  function buildCommands(entry) {
    var item = { quantity: 1 };
    for (var key in entry.item) {
      if (Object.prototype.hasOwnProperty.call(entry.item, key)) item[key] = entry.item[key];
    }
    return [
      { type: 'money.spend', amount: entry.price },
      { type: 'item.grant', item: item },
    ];
  }

  function render(stock) {
    stockEl.textContent = '';
    stock.items.forEach(function (entry) {
      var li = document.createElement('li');
      li.className = 'shop-item';

      var name = document.createElement('strong');
      name.textContent = entry.item.name;
      li.appendChild(name);

      var button = document.createElement('button');
      button.type = 'button';
      var left = remaining(entry);
      button.textContent = entry.price + ' G 购买';
      button.disabled = left === 0;
      button.addEventListener('click', function () {
        void buy(entry, stock);
      });
      li.appendChild(button);

      var desc = document.createElement('p');
      desc.className = 'shop-item-desc';
      desc.textContent =
        (entry.item.description || '') + (left === null ? '' : '（剩余 ' + left + ' 件）');
      li.appendChild(desc);

      stockEl.appendChild(li);
    });
  }

  async function buy(entry, stock) {
    if (busy) return;
    busy = true;
    try {
      var result = await host.commit({ commands: buildCommands(entry) });
      if (result.ok) {
        if (typeof entry.limit === 'number') {
          sold[entry.id] = (sold[entry.id] || 0) + 1;
          await host.storage.save.set(SOLD_KEY, sold);
        }
        notice('购买了「' + entry.item.name + '」。', 'info');
        render(stock);
        await host.ai.note('主角在杂货铺买了「' + entry.item.name + '」').catch(function () {});
      } else if (result.code === 'PRECONDITION_FAILED') {
        notice('金钱不足', 'error');
      } else if (result.code === 'BUSY' || result.code === 'IN_COMBAT') {
        notice('现在不方便交易，稍后再来。', 'error');
      } else {
        notice('购买失败：' + result.message, 'error');
      }
    } catch (error) {
      notice('购买失败：' + (error && error.message ? error.message : String(error)), 'error');
    } finally {
      busy = false;
    }
  }

  async function main() {
    var stock = JSON.parse(await host.assets.readText('stock.json'));
    var saved = await host.storage.save.get(SOLD_KEY).catch(function () {
      return undefined;
    });
    if (saved && typeof saved === 'object') sold = saved;
    render(stock);
    showBalance(await host.read('player'));
    await host.subscribe('player', showBalance);
  }

  main().catch(function (error) {
    notice('杂货铺打不开：' + (error && error.message ? error.message : String(error)), 'error');
  });
})();

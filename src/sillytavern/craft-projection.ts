/**
 * 制作投影 — 结算结果 → 文本（Q-21 刀四）
 *
 * 把三阶段结算的**结果**翻译成两样给人和 AI 看的东西：
 *   - `buildCraftPanelLines()` — 世界书 `<action_info>` 竖线表面板
 *   - `buildCraftDescription()` — 一句话结果摘要
 *
 * ## 为什么单独一个文件
 *
 * 这两个函数此前长在 `craft-resolver.ts` 尾部（约 140 行），于是那个文件同时承担
 * 三件不相干的事：确定性结算数学、AI 面向的 `$craft` 门面、以及展示层。
 * 结果是「稀有品质的 DC 减免改了」和「面板里那句话换个措辞」落在同一个文件、
 * 同一份测试的 setup 成本上。
 *
 * 战斗 v3 已经做过同一刀 —— `projection-agent.ts` / `projection-ui.ts` 在内核之外
 * 把 `DomainEvent[]` 翻成文本与 UI 事件，`combat-v3/index.ts` 明写投影是
 * 「内部但分离」的。制作照抄这个形状。
 *
 * ## ADR-28 提醒
 *
 * 竖线表面板是**给没有 Code 层的纯文本 AI** 的遗留手段（世界书 #683615 /  #223221）。
 * 我们有真的结算结果，面板只是把它渲染出来 —— 所以这一层里不允许出现任何计算：
 * 每个数字都必须来自入参的四个结果对象。要改规则，改 `craft-resolver` / `craft-dc`。
 *
 * 四个入参就是 `resolveCraft` 手里的全部东西，两个函数都是它们的纯函数。
 */

import type {
  QualityLevel,
  CraftActionRequest,
  CraftPrepResult,
  CraftCheckResult,
  CraftSettleResult,
} from './types';
import { CRAFT_INDUSTRY_ATTRIBUTE } from './types';

/**
 * 生成三级面板行（对齐世界书 `<action_info>` 模板）。
 */
export function buildCraftPanelLines(
  request: CraftActionRequest,
  prep: CraftPrepResult,
  check: CraftCheckResult,
  settle: CraftSettleResult,
): string[] {
  const lines: string[] = [];

  // Phase 1: 生产准备
  lines.push('{生产准备}');
  lines.push(
    `| 目标: ${request.productName} | 数量: ${prep.batchCount} | 类型: ${request.stage} | 品质: ${request.targetQuality} |`,
  );
  lines.push(
    `| 行业: ${request.industry} | 核心属性: ${CRAFT_INDUSTRY_ATTRIBUTE[request.industry]} |`,
  );
  lines.push(
    `| 管制投入物检查: ${prep.regulatedCheck.passed ? '不涉及/有许可' : `涉及-无许可(${prep.regulatedCheck.missingLicenses.join(',')})`} |`,
  );
  lines.push(
    `| 品质要求检查: ${prep.qualityReqCheck.passed ? '满足' : `不满足(${prep.qualityReqCheck.downgradeReason})`} |`,
  );
  lines.push(
    `| 资源预检: HP[${request.currentResources.hp}/${request.resourceCosts.hp * prep.batchCount}] MP[${request.currentResources.mp}/${request.resourceCosts.mp * prep.batchCount}] SP[${request.currentResources.sp}/${request.resourceCosts.sp * prep.batchCount}] | 状态: ${prep.resourceCheck.sufficient ? '充足' : '不足(终止)'} |`,
  );
  lines.push(
    `| 批量检查: ${request.stage === '成品' && !request.hasRecipe ? '成品-图纸(未持有)->强制单件' : '允许批量'} |`,
  );
  const matStr = request.materials.map((m) => `${m.itemName} x${m.quantity}`).join(', ');
  lines.push(`| 投入物: ${matStr} |`);

  // Phase 2: 制作检定
  if (prep.canProceed) {
    const bd = check.breakdown;
    lines.push('{制作检定}');
    lines.push(`| 类型: ${request.stage} | 数量: ${prep.batchCount} |`);
    const dcDetail = `${bd.baseDC} + [材料 DC ${bd.materialDCModifier}] - [减免 ${bd.bonusDCReduction}] = ${bd.finalDC}`;
    lines.push(`| 基础DC: ${dcDetail} |`);
    lines.push(
      `| 检定加值: 属性[${bd.fixedBonusBreakdown.attribute}] + 技能[${bd.fixedBonusBreakdown.skill}] + 道具[${bd.fixedBonusBreakdown.tool}] + 身份[${bd.fixedBonusBreakdown.identity}] = 固定加值 [${bd.fixedBonus}] |`,
    );
    const advStr = bd.advantage
      ? `优势:d20(${bd.diceRolls.join(',')})→取值${bd.diceValue}`
      : bd.disadvantage
        ? `劣势:d20(${bd.diceRolls.join(',')})→取值${bd.diceValue}`
        : `正常:d20(${bd.diceValue})`;
    lines.push(`| 掷骰: ${advStr} |`);
    lines.push(
      `| 判定公式: ${bd.fixedBonus} + ${bd.diceValue} = ${bd.totalValue} vs DC ${bd.finalDC} |`,
    );
    lines.push(`| 检定结果: ${bd.rating} |`);
    lines.push(
      `| 资源消耗: HP[${settle.breakdown.resourceCost.hp}] MP[${settle.breakdown.resourceCost.mp}] SP[${settle.breakdown.resourceCost.sp}] |`,
    );
  } else {
    lines.push('{制作检定}');
    lines.push(`| 状态: [终止] ${prep.stopReason} |`);
  }

  // Phase 3: 结算
  const sb = settle.breakdown;
  lines.push('{生产结算}');
  lines.push(`| 类型: ${request.stage} |`);

  if (request.stage === '基础加工' && check.breakdown.rating !== '大失败') {
    lines.push('| 状态: 基础加工完成，无损耗 |');
  } else if (sb.materialLoss.lossRate > 0) {
    lines.push(
      `| 状态: [制作${check.breakdown.rating}] | 投入物损耗 ${Math.round(sb.materialLoss.lossRate * 100)}% |`,
    );
    const lossStr = sb.materialLoss.lostMaterials
      .map((m) => `${m.itemName} x${m.quantity}`)
      .join(', ');
    lines.push(`| 损失: ${lossStr} 损毁 |`);
  } else {
    lines.push(
      `| 状态: [制作成功] | 品质: ${sb.outputQuality}${sb.qualityDowngraded ? ` (降级前: ${request.targetQuality})` : ''} |`,
    );
    if (sb.certification) {
      lines.push(`| 认证: ${sb.certification} |`);
    }
    if (sb.perfectionBonus) {
      if (sb.perfectionBonus.batchExtraYield) {
        lines.push(`| 精益求精: 批量-产量+${sb.perfectionBonus.batchExtraYield} |`);
      } else if (sb.perfectionBonus.singleExtraAffix) {
        lines.push(`| 精益求精: 单件-获得额外词条: ${sb.perfectionBonus.singleExtraAffix} |`);
      } else if (sb.perfectionBonus.dcModifierDowngrade) {
        lines.push(`| 精益求精: 单件-DC修正降级${sb.perfectionBonus.dcModifierDowngrade} |`);
      }
    }
    lines.push(
      `| 产出列表: ${request.productName}(${sb.outputQuality}, DC修正+${sb.productDCModifier}) x${prep.batchCount} |`,
    );
    if (sb.expReward.actualExp > 0) {
      lines.push(
        `| 经验依据: ${request.stage} ${sb.outputQuality} -> 基础EXP ${sb.expReward.baseExp} |`,
      );
      lines.push(
        `| 结算状态: ${sb.expReward.tierSuppressed ? '层级压制归零' : '正常结算'} | 实得EXP: ${sb.expReward.actualExp} |`,
      );
      lines.push(`| 奖励: EXP +${sb.expReward.actualExp} | FP +${sb.fpReward} |`);
    }
  }

  return lines;
}

/**
 * 生成一句话结果摘要。
 *
 * 🔴 `productName` / `outputQuality` / `rating` / `success` 四项此前是**独立形参**，
 *    由 `resolveCraft` 在调用处各算一遍（`success` 尤其是自己重算的
 *    `rating === '成功' || rating === '精益求精'`）。四个入参里已经有全部信息，
 *    于是这里就地推导 —— 少四个可以传错的口子。
 */
export function buildCraftDescription(
  request: CraftActionRequest,
  prep: CraftPrepResult,
  check: CraftCheckResult,
  settle: CraftSettleResult,
): string {
  const productName = request.productName;
  const rating = check.breakdown.rating;
  const quality: QualityLevel = settle.breakdown.outputQuality;
  const success = rating === '成功' || rating === '精益求精';

  // 准备阶段失败优先于检定失败
  if (!success && !prep.canProceed) {
    return `制作「${productName}」终止: ${prep.stopReason ?? '准备阶段不通过'}。`;
  }
  if (rating === '大失败') {
    return `制作「${productName}」大失败！投入物全部损毁。`;
  }
  if (rating === '失败') {
    return `制作「${productName}」失败，${Math.round(settle.breakdown.materialLoss.lossRate * 100)}% 投入物损耗。`;
  }

  let desc = `成功制作「${productName}」(${quality}品质)`;
  if (settle.breakdown.qualityDowngraded) {
    desc += `，因品质继承降级`;
  }
  if (rating === '精益求精') {
    desc += `，精益求精！`;
  }
  desc += `，获得 ${settle.breakdown.expReward.actualExp} EXP，${settle.breakdown.fpReward} FP。`;
  return desc;
}

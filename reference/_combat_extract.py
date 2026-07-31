# -*- coding: utf-8 -*-
"""
战斗对话提取器（临时数据收集脚本）

从 SillyTavern 导出的 JSONL 里，按 <骰子池>+战斗得分 聚类出每场战斗，
渲染成干净 Markdown（保留 gametxt 正文 + action_info 战斗面板 + 骰子池，
丢弃 Recorder 声明 / Step1-10 思维链 / summary / char_info 大面板）。

用法:
  python _combat_extract.py preview 7      # 终端预览第 7 场
  python _combat_extract.py export          # 全量导出到 ./战斗对话样本/
  python _combat_extract.py list            # 仅打印场次清单
"""
import json
import re
import sys
import os

FN = "命定之诗与黄昏之歌v4.2 - 2026-04-03@17h36m38s398ms imported.jsonl"
OUT_DIR = "战斗对话样本"

COMBAT_WORDS = [
    "攻击", "伤害", "命中", "闪避", "暴击", "格挡", "穿透", "护甲", "生命值",
    "HP", "法术伤害", "能量伤害", "物理伤害", "敌人", "怪物", "魔物", "敌军",
    "BOSS", "boss", "骷髅", "食尸鬼", "恶魔", "巨龙", "亡灵", "致死", "击杀",
    "斩杀", "击毙", "死亡", "重伤", "护盾", "反击", "连击", "范围伤害",
]
# 战斗面板专属词（炼金/制作/R18/装备词条绝不会出现）—— 用于精准判定
# 排除坑: {战况总览}(制作复用) / 先攻(装备词条"先攻修正"蹭到)
COMBAT_PANEL_WORDS = [
    "攻方", "守方", "{攻击行动}", "行动顺序",
    "是否存活", "{支援行动}", "{反击行动}",
]
SCORE_THRESH = 8   # 泛词强度阈值（仅作元数据参考，不再用于判定）
GAP_THRESH = 16    # 聚类间隔（消息条数）


def load_msgs():
    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, FN), encoding="utf-8") as f:
        lines = f.readlines()
    return [json.loads(l) for l in lines[1:]]


def combat_score(mes):
    """泛词强度（元数据，衡量战斗激烈程度）"""
    return sum(mes.count(w) for w in COMBAT_WORDS)


def is_combat_msg(mes):
    """精准战斗判定：含骰子池 且 面板出现战斗专属词"""
    if "<骰子池>" not in mes:
        return False
    return any(w in mes for w in COMBAT_PANEL_WORDS)


def cluster(msgs):
    anchors = [i for i, m in enumerate(msgs) if is_combat_msg(m.get("mes") or "")]
    if not anchors:
        return []
    clusters = []
    cur = [anchors[0]]
    for i in anchors[1:]:
        if i - cur[-1] <= GAP_THRESH:
            cur.append(i)
        else:
            clusters.append(cur)
            cur = [i]
    clusters.append(cur)
    return clusters


# ===== 提取规则 =====
RE_GAMETXT = re.compile(r"<gametxt>([\s\S]*?)</gametxt>", re.IGNORECASE)
RE_ACTION = re.compile(r"<action_info>([\s\S]*?)</action_info>", re.IGNORECASE)
RE_DICE = re.compile(r"<骰子池>([^\n<]{0,400})")  # 骰子池无闭合，取到换行/下一标签


def extract_ai(mes):
    """AI 消息 → (正文段落列表, 战斗面板列表, 骰子池片段)"""
    gametxts = RE_GAMETXT.findall(mes)
    actions = RE_ACTION.findall(mes)
    dice = RE_DICE.findall(mes)
    return gametxts, actions, dice


def render_battle(msgs, cluster, cid):
    lo = max(0, cluster[0] - 1)
    hi = min(len(msgs) - 1, cluster[-1] + 1)
    strength = sum(combat_score(msgs[j].get("mes") or "") for j in cluster)
    date = msgs[cluster[0]].get("send_date", "")[:10]
    lines = []
    lines.append(f"# 第 {cid:02d} 场战斗")
    lines.append(f"- 日期: {date}")
    lines.append(f"- 行号: {cluster[0]+2}-{cluster[-1]+2}（共 {hi-lo+1} 条消息，{len(cluster)} 个战斗回合）")
    lines.append(f"- 战斗强度: {strength}")
    lines.append("")
    lines.append("---")
    lines.append("")
    for j in range(lo, hi + 1):
        m = msgs[j]
        mes = m.get("mes") or ""
        if m.get("is_user"):
            lines.append(f"## 👤 玩家（行 {j+2}）")
            lines.append("")
            lines.append(mes.strip())
            lines.append("")
        elif m.get("is_system"):
            # system 多为 Recorder 输出（含战斗），按 AI 处理
            gametxts, actions, dice = extract_ai(mes)
            if not (gametxts or actions or dice):
                continue
            lines.append(f"## 🎭 Recorder（行 {j+2}）")
            lines.append("")
            for d in dice:
                lines.append(f"> 🎲 `<骰子池>{d.strip()[:200]}`")
                lines.append("")
            for a in actions:
                lines.append("**【行动面板】**")
                lines.append("```xml")
                lines.append(f"<action_info>{a.strip()}</action_info>")
                lines.append("```")
                lines.append("")
            for g in gametxts:
                lines.append(g.strip())
                lines.append("")
        else:
            gametxts, actions, dice = extract_ai(mes)
            if not (gametxts or actions or dice):
                continue
            lines.append(f"## 🎙️ Recorder（行 {j+2}）")
            lines.append("")
            for d in dice:
                lines.append(f"> 🎲 `<骰子池>{d.strip()[:200]}`")
                lines.append("")
            for a in actions:
                lines.append("**【行动面板】**")
                lines.append("```xml")
                lines.append(f"<action_info>{a.strip()}</action_info>")
                lines.append("```")
                lines.append("")
            for g in gametxts:
                lines.append(g.strip())
                lines.append("")
    return "\n".join(lines), date, strength


def cmd_list(msgs):
    clusters = cluster(msgs)
    print(f"共 {len(clusters)} 场战斗")
    for ci, c in enumerate(clusters, 1):
        strength = sum(combat_score(msgs[j].get("mes") or "") for j in c)
        date = msgs[c[0]].get("send_date", "")[:10]
        print(f"  第{ci:02d}场 行{c[0]+2}-{c[-1]+2} 回合{len(c)} 强度{strength} {date}")


def cmd_preview(msgs, cid):
    clusters = cluster(msgs)
    if cid < 1 or cid > len(clusters):
        print(f"场次号应在 1-{len(clusters)}"); return
    text, _, _ = render_battle(msgs, clusters[cid - 1], cid)
    # 终端只打印前 4000 字
    print(text[:4000])
    if len(text) > 4000:
        print(f"\n... [截断，全文 {len(text)} 字，用 export 写文件查看]")


def cmd_export(msgs):
    clusters = cluster(msgs)
    here = os.path.dirname(os.path.abspath(__file__))
    out = os.path.join(here, OUT_DIR)
    os.makedirs(out, exist_ok=True)
    index = ["# 战斗对话样本索引", "", f"源文件: `{FN}`", f"共 {len(clusters)} 场战斗", "", "| 场次 | 行号 | 回合数 | 强度 | 日期 | 文件 |", "|---|---|---|---|---|---|"]
    for ci, c in enumerate(clusters, 1):
        text, date, strength = render_battle(msgs, c, ci)
        fname = f"第{ci:02d}场_行{c[0]+2}-{c[-1]+2}_{date}_强度{strength}.md"
        with open(os.path.join(out, fname), "w", encoding="utf-8") as f:
            f.write(text)
        index.append(f"| {ci} | {c[0]+2}-{c[-1]+2} | {len(c)} | {strength} | {date} | [{fname}]({fname}) |")
    with open(os.path.join(out, "_INDEX.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(index))
    print(f"已导出 {len(clusters)} 场到 {out}")


if __name__ == "__main__":
    msgs = load_msgs()
    cmd = sys.argv[1] if len(sys.argv) > 1 else "list"
    if cmd == "list":
        cmd_list(msgs)
    elif cmd == "preview":
        cmd_preview(msgs, int(sys.argv[2]))
    elif cmd == "export":
        cmd_export(msgs)
    else:
        print(__doc__)

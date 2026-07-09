<script setup lang="ts">
import type { DecisionResp } from '@/api/client'

defineProps<{ decision: DecisionResp }>()

const ACTION_STYLE: Record<string, { bg: string; color: string }> = {
  '分批买入': { bg: 'rgba(196,69,54,0.12)', color: '#C44536' },
  '继续定投': { bg: 'rgba(76,126,103,0.12)', color: '#4C7E67' },
  '持有观望': { bg: 'rgba(90,106,96,0.10)', color: '#5A6A60' },
  '停止加仓': { bg: 'rgba(200,167,91,0.15)', color: '#9A7B3C' },
  '部分观察': { bg: 'rgba(200,167,91,0.15)', color: '#9A7B3C' },
  '考虑替换': { bg: 'rgba(90,106,96,0.12)', color: '#5A6A60' },
  '观察': { bg: 'rgba(168,178,168,0.15)', color: '#5A6A60' },
}

function actionStyle(action: string) {
  return ACTION_STYLE[action] || ACTION_STYLE['观察']
}
</script>

<template>
  <div class="decision card">
    <div class="head">
      <span class="action" :style="actionStyle(decision.action)">{{ decision.action }}</span>
      <span class="conf" :class="'conf-' + decision.confidence">置信 {{ decision.confidence }}</span>
    </div>
    <div class="summary">{{ decision.summary }}</div>
    <div class="block" v-if="decision.reasons?.length">
      <div class="lbl">依据</div>
      <ul><li v-for="(r, i) in decision.reasons" :key="'r' + i">{{ r }}</li></ul>
    </div>
    <div class="block warn" v-if="decision.risks?.length">
      <div class="lbl">风险</div>
      <ul><li v-for="(r, i) in decision.risks" :key="'k' + i">{{ r }}</li></ul>
    </div>
    <div class="pos">{{ decision.position_rule }}</div>
    <div class="next">{{ decision.next_check }}</div>
    <div class="disc">{{ decision.disclaimer || '数据辅助分析，不构成投资建议。' }}</div>
  </div>
</template>

<style scoped>
.decision { margin-bottom: 4px; }
.head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
.action {
  font-size: 18px; font-weight: 700; padding: 6px 14px; border-radius: 8px;
  font-family: 'Noto Serif SC', 'PingFang SC', serif;
}
.conf { font-size: 12px; color: var(--text-secondary); white-space: nowrap; }
.conf-高 { color: #4C7E67; font-weight: 600; }
.conf-中 { color: #9A7B3C; }
.conf-低 { color: #A8B2A8; }
.summary { font-size: 14px; line-height: 1.6; color: var(--text); margin-bottom: 10px; }
.block { font-size: 12px; color: var(--text-secondary); margin: 8px 0; }
.block ul { margin: 4px 0 0; padding-left: 18px; line-height: 1.6; }
.lbl { font-size: 11px; font-weight: 600; color: #4C7E67; margin-bottom: 2px; }
.block.warn .lbl { color: #C44536; }
.pos { font-size: 12px; color: var(--text-secondary); background: var(--bg-soft, #F2F6F1); border-radius: 8px; padding: 8px 10px; margin-top: 8px; line-height: 1.5; }
.next { font-size: 11px; color: var(--text-hint); margin-top: 8px; }
.disc { font-size: 11px; color: var(--text-hint); margin-top: 8px; line-height: 1.5; }
</style>

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRenderer, nextTick } from 'vue'
import type { AccuracyRecord, AccuracyReport, AccuracySummary } from '@/utils/overseasAccuracy'
import actualPublicLedger from '../../public/data/overseas-accuracy.json'
import OverseasAccuracyPanel from './OverseasAccuracyPanel.vue'

const mocks = vi.hoisted(() => ({ load: vi.fn() }))
vi.mock('@/utils/overseasAccuracy', async original => ({
  ...await original<typeof import('@/utils/overseasAccuracy')>(),
  // Only the public request boundary is replaced. The real SFC and shared
  // fund/model/date/freshness policy run, including reactive clock updates.
  loadOverseasAccuracy: mocks.load,
}))

interface HostNode { tag: string; text: string; children: HostNode[]; parent: HostNode | null; props: Record<string, unknown> }
const node = (tag = 'root', text = ''): HostNode => ({ tag, text, children: [], parent: null, props: {} })
const renderer = createRenderer<HostNode, HostNode>({
  createElement: tag => node(tag), createText: text => node('#text', text), createComment: text => node('#comment', text),
  setText: (item, text) => { item.text = text }, setElementText: (item, text) => { item.text = text; item.children = [] },
  patchProp: (item, key, _before, value) => { item.props[key] = value },
  insert(item, parent, anchor = null) {
    if (item.parent) item.parent.children.splice(item.parent.children.indexOf(item), 1)
    item.parent = parent
    const index = anchor ? parent.children.indexOf(anchor) : -1
    if (index < 0) parent.children.push(item)
    else parent.children.splice(index, 0, item)
  },
  remove(item) { if (item.parent) item.parent.children.splice(item.parent.children.indexOf(item), 1); item.parent = null },
  parentNode: item => item.parent,
  nextSibling: item => item.parent?.children[item.parent.children.indexOf(item) + 1] ?? null,
})
const text = (item: HostNode): string => (item.tag === '#comment' ? '' : item.text) + item.children.map(text).join(' ')
const nodes = (item: HostNode): HostNode[] => [item, ...item.children.flatMap(nodes)]
const rows = (root: HostNode) => nodes(root).filter(item => item.props.class === 'accuracy-row')
function fund(root: HostNode, code: string) {
  const row = rows(root).find(item => text(item).includes(code))
  expect(row, code).toBeDefined()
  return row!
}
async function settle() {
  for (let index = 0; index < 10; index++) await Promise.resolve()
  await nextTick()
}
const unmounts: Array<() => void> = []
function mount() {
  const root = node(), app = renderer.createApp(OverseasAccuracyPanel)
  app.mount(root)
  let mounted = true
  const unmount = () => { if (mounted) { mounted = false; app.unmount() } }
  unmounts.push(unmount)
  return { root, unmount }
}

const oldOwn: AccuracyRecord = {
  code: '018147', name: '公开合成QDII', model_version: 'active-v1', status: 'settled',
  alignment_version: 'observation-target-v2', prediction_date: '2026-10-16',
  target_nav_date: '2026-10-15', base_nav_date: '2026-10-14',
  observed_at: '2026-10-16T14:35:00+08:00', settled_at: '2026-10-16T19:50:55+08:00',
  predicted_change: 0, actual_change: 0, error: 0,
}
const freshOther: AccuracyRecord = {
  ...oldOwn, code: '012920', prediction_date: '2026-10-21', target_nav_date: '2026-10-20',
  base_nav_date: '2026-10-19', observed_at: '2026-10-21T14:35:00+08:00',
  settled_at: '2026-10-21T20:18:08+08:00',
}
function summary(change: Partial<AccuracySummary> = {}): AccuracySummary {
  return { model_version: 'active-v1', samples: 22, status: 'healthy', confidence: '较高',
    mae: 0.784, bias: -0.058, direction_accuracy: 81.8, error_band: 1.171, ...change }
}
function report(records: AccuracyRecord[] = [oldOwn, freshOther], own: Partial<AccuracySummary> = {}): AccuracyReport {
  return { updated_at: '2026-10-21T20:19:19+08:00',
    pipeline: { heartbeat_at: '2026-10-21T20:19:19+08:00',
      last_effective_settlement_at: freshOther.settled_at, last_effective_prediction_at: freshOther.observed_at },
    summary: { '018147': summary(own), '012920': summary() }, records }
}
let documentEvents: EventTarget & { visibilityState: string }
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-22T02:00:00Z'))
  mocks.load.mockReset().mockResolvedValue(report())
  documentEvents = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  vi.stubGlobal('document', documentEvents)
})
afterEach(() => {
  unmounts.splice(0).forEach(unmount => unmount())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('mounted OverseasAccuracyPanel per-model freshness', () => {
  it('shows each fund own effective time and expiry while retaining clearly historical metrics', async () => {
    const { root } = mount()
    await settle()
    const own = text(fund(root, '018147')), other = text(fund(root, '012920'))
    expect(own).toContain('精度数据过期')
    expect(own).not.toContain('较高')
    expect(own).toContain(oldOwn.settled_at)
    expect(own).not.toContain(freshOther.settled_at)
    expect(own).toContain('历史指标，仅供回看')
    expect(own).toContain('0.78%')
    expect(other).toContain('较高')
    expect(other).toContain(freshOther.settled_at)
    expect(nodes(fund(root, '018147')).find(item => item.tag === 'time')?.props.datetime).toBe(oldOwn.settled_at)
  })

  it('does not use another version fresh settlement for the displayed summary version', async () => {
    mocks.load.mockResolvedValue(report([oldOwn, { ...freshOther, code: '018147', model_version: 'other-v2' }]))
    const { root } = mount()
    await settle()
    expect(text(fund(root, '018147'))).toContain('精度数据过期')
    expect(text(fund(root, '018147'))).toContain(oldOwn.settled_at)
    expect(text(fund(root, '018147'))).not.toContain(freshOther.settled_at)
    expect(text(fund(root, '018147'))).toContain('active-v1')
  })

  it.each(['missing settlement', 'empty window', 'missing model version', 'future settlement'])('marks %s explicitly unknown', async mode => {
    const value = report()
    if (mode === 'missing settlement') value.records[0] = { ...oldOwn, settled_at: undefined }
    if (mode === 'empty window') value.records = []
    if (mode === 'missing model version') value.summary['018147'] = summary({ model_version: undefined })
    if (mode === 'future settlement') value.records[0] = { ...oldOwn, settled_at: '2026-10-22T10:05:00.000000001+08:00' }
    mocks.load.mockResolvedValue(value)
    const { root } = mount()
    await settle()
    const own = text(fund(root, '018147'))
    expect(own).toContain('精度数据过期')
    expect(own).toContain('结算有效时间未知')
    expect(own).toContain('历史指标，仅供回看')
    expect(own).not.toContain('较高')
    expect(nodes(fund(root, '018147')).some(item => item.tag === 'time')).toBe(false)
  })

  it('preserves explicit zero metrics and nulls without adding new supported funds', async () => {
    const own = { ...freshOther, code: '018147' }
    const value = report([own, freshOther], { mae: 0, direction_accuracy: 0, error_band: 0 })
    value.summary['012920'] = summary({ mae: null, direction_accuracy: null, error_band: null })
    value.summary['539002'] = summary()
    value.records.push({ ...freshOther, code: '539002' })
    mocks.load.mockResolvedValue(value)
    const { root } = mount()
    await settle()
    expect(text(fund(root, '018147'))).toContain('0.00%')
    expect(text(fund(root, '018147'))).toContain('±0.00%')
    expect(text(fund(root, '012920'))).toContain('--')
    expect(text(fund(root, '012920'))).not.toContain('0.00%')
    expect(rows(root)).toHaveLength(2)
    expect(text(root)).not.toContain('539002')
  })

  it.each([true, false])('keeps zero-sample collection semantics with own prediction present=%s', async present => {
    const own = { ...freshOther, code: '018147', status: 'pending' }
    mocks.load.mockResolvedValue(report(present ? [own, freshOther] : [freshOther], {
      samples: 0, status: 'collecting', confidence: '样本积累中', mae: null, bias: null,
      direction_accuracy: null, error_band: null,
    }))
    const { root } = mount()
    await settle()
    const ownText = text(fund(root, '018147'))
    expect(ownText).toContain('精度样本重新积累中')
    expect(ownText).toContain('0 个可训练样本')
    expect(ownText).not.toContain('较高')
    expect(ownText).toContain(present ? own.observed_at! : '预测有效时间未知')
    expect(ownText).not.toContain('结算有效时间')
  })

  it('expires on the mounted clock after crossing the shared 96-hour boundary', async () => {
    const time = new Date(Date.now() - 96 * 60 * 60 * 1000).toISOString()
    mocks.load.mockResolvedValue(report([{ ...oldOwn, settled_at: time }, freshOther]))
    const { root } = mount()
    await settle()
    expect(text(fund(root, '018147'))).toContain('较高')
    await vi.advanceTimersByTimeAsync(30_000)
    await nextTick()
    expect(text(fund(root, '018147'))).toContain('精度数据过期')
    expect(text(fund(root, '018147'))).not.toContain('较高')
    expect(text(fund(root, '018147'))).toContain(time)
    expect(mocks.load).toHaveBeenCalledTimes(1)
  })

  it('refreshes the same policy immediately on becoming visible after a clock jump', async () => {
    const time = new Date(Date.now() - 96 * 60 * 60 * 1000 + 10_000).toISOString()
    mocks.load.mockResolvedValue(report([{ ...oldOwn, settled_at: time }, freshOther]))
    const { root } = mount()
    await settle()
    expect(text(fund(root, '018147'))).toContain('较高')
    vi.setSystemTime(new Date(Date.now() + 20_000))
    documentEvents.visibilityState = 'hidden'
    documentEvents.dispatchEvent(new Event('visibilitychange'))
    await nextTick()
    expect(text(fund(root, '018147'))).toContain('较高')
    documentEvents.visibilityState = 'visible'
    documentEvents.dispatchEvent(new Event('visibilitychange'))
    await nextTick()
    expect(text(fund(root, '018147'))).toContain('精度数据过期')
    expect(mocks.load).toHaveBeenCalledTimes(1)
  })

  it('removes the timer/listener and invalidates late load completion on unmount', async () => {
    let finish!: (value: AccuracyReport) => void
    mocks.load.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const add = vi.spyOn(documentEvents, 'addEventListener')
    const remove = vi.spyOn(documentEvents, 'removeEventListener')
    const { root, unmount } = mount()
    expect(vi.getTimerCount()).toBe(1)
    expect(add).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
    const signal = mocks.load.mock.calls[0]![1].signal as AbortSignal
    expect(signal.aborted).toBe(false)
    unmount()
    expect(signal.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    expect(remove).toHaveBeenCalledWith('visibilitychange', add.mock.calls[0]![1])
    finish(report())
    await settle()
    expect(text(root)).not.toContain('018147')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('renders actual public artifact fund-specific times without substituting the file update time', async () => {
    vi.setSystemTime(new Date(actualPublicLedger.updated_at))
    const actual = actualPublicLedger as unknown as AccuracyReport
    mocks.load.mockResolvedValue(actual)
    const { root } = mount()
    await settle()
    for (const code of ['018147', '012920']) {
      const version = actual.summary[code]!.model_version
      const eligible = actual.records.filter(row => row.code === code && row.model_version === version && row.status === 'settled')
      const latest = eligible.reduce((left, right) => Date.parse(left.settled_at!) > Date.parse(right.settled_at!) ? left : right)
      expect(text(fund(root, code))).toContain(latest.settled_at)
      if (Date.now() - Date.parse(latest.settled_at!) > 96 * 60 * 60 * 1000) {
        expect(text(fund(root, code))).toContain('精度数据过期')
        expect(text(fund(root, code))).not.toContain(actual.summary[code]!.confidence)
      }
    }
  })
})

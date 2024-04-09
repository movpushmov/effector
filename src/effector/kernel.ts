import type {Leaf} from '../forest/index.h'

import type {Node, NodeUnit, StateRef, Stack} from './index.h'
import {readRef} from './stateRef'
import {getForkPage, getGraph, getValue} from './getter'
import type {Scope} from './unit.h'
import {add, forEach} from './collection'

/** Names of priority groups */
type PriorityTag = 'child' | 'pure' | 'read' | 'barrier' | 'sampler' | 'effect'

export type BarrierPriorityTag = 'read' | 'barrier' | 'sampler' | 'effect'

/** Dedicated local metadata */
type Local = {
  fail: boolean
  failReason?: unknown
  scope: {[key: string]: any}
}

/**
 * Position in the current branch,
 * including call stack, priority type
 * and index of next step in the executed Node
 */
type Layer = {
  idx: number
  stack: Stack
  type: PriorityTag
  id: number
}

function createEffectorQueue() {
  /** Queue as linked list or skew heap */
  type QueueItem = {
    /** node value */
    v: Layer
    /** left node. always null in queue but used in skew heap */
    l: QueueItem | null
    /** right node */
    r: QueueItem | null
  }
  type QueueBucket = {
    first: QueueItem | null
    last: QueueItem | null
    size: number
  }

  let heap: QueueItem | null = null

  const merge = (
    a: QueueItem | null,
    b: QueueItem | null,
  ): QueueItem | null => {
    if (!a) return b
    if (!b) return a

    let ret
    if (
      /**
       * if both nodes has the same PriorityType
       * and first node is created after second one
       */
      (a.v.type === b.v.type && a.v.id > b.v.id) ||
      /**
       * greater priority mean bucket of first node is executed later
       * e.g  a: "sampler", b: "barrier"
       */
      getPriority(a.v.type) > getPriority(b.v.type)
    ) {
      ret = a
      a = b
      b = ret
    }
    ret = merge(a.r, b)
    a.r = a.l
    a.l = ret

    return a
  }

  /** queue buckets for each PriorityType */
  const queue: QueueBucket[] = []
  let ix = 0
  while (ix < 6) {
    /**
     * although "sampler" and "barrier" are using heap instead of linked list,
     * their buckets are still useful: they maintains size of heap queue
     */
    add(queue, {first: null, last: null, size: 0})
    ix += 1
  }

  const deleteMin = () => {
    for (let i = 0; i < 6; i++) {
      const list = queue[i]
      if (list.size > 0) {
        /**
         * bucket 3 is for "barrier" PriorityType (used in combine)
         * bucket 4 is for "sampler" PriorityType (used in sample and guard)
         */
        if (i === 3 || i === 4) {
          list.size -= 1
          const value = heap!.v
          heap = merge(heap!.l, heap!.r)
          return value
        }
        if (list.size === 1) {
          list.last = null
        }
        const item = list.first
        list.first = item!.r
        list.size -= 1
        return item!.v
      }
    }
  }
  const pushFirstHeapItem = (
    type: PriorityTag,
    page: Leaf | null,
    node: Node,
    parent: Stack | null,
    value: any,
    scope?: Scope | null | void,
    meta?: Record<string, any> | void,
  ) =>
    pushHeap(
      0,
      {
        a: null,
        b: null,
        node,
        parent,
        value,
        page,
        scope,
        meta,
      },
      type,
      0,
    )
  const pushHeap = (
    idx: number,
    stack: Stack,
    type: PriorityTag,
    id: number,
  ) => {
    const priority = getPriority(type)
    const bucket: QueueBucket = queue[priority]
    const item: QueueItem = {
      v: {idx, stack, type, id},
      l: null,
      r: null,
    }
    /**
     * bucket 3 is for "barrier" PriorityType (used in combine)
     * bucket 4 is for "sampler" PriorityType (used in sample and guard)
     */
    if (priority === 3 || priority === 4) {
      heap = merge(heap, item)
    } else {
      if (bucket.size === 0) {
        bucket.first = item
      } else {
        bucket.last!.r = item
      }
      bucket.last = item
    }
    bucket.size += 1
  }

  const getPriority = (t: PriorityTag) => {
    switch (t) {
      case 'child':
        return 0
      case 'pure':
        return 1
      case 'read':
        return 2
      case 'barrier':
        return 3
      case 'sampler':
        return 4
      case 'effect':
        return 5
      default:
        return -1
    }
  }

  const barriers = new Set<string | number>()

  return {
    barriers,
    pushFirstHeapItem,
    pushHeap,
    deleteMin,
  }
}

let isRoot = true
export let isWatch = false
export let isPure = false
export let currentPage: Leaf | null = null
export let forkPage: Scope | void | null
let currentQueue: ReturnType<typeof createEffectorQueue> | null = null
export const setForkPage = (newForkPage: Scope | void | null) => {
  forkPage = newForkPage
}
export const setCurrentPage = (newPage: Leaf | null) => {
  currentPage = newPage
}

const getPageForRef = (page: Leaf | null, id: string) => {
  if (page) {
    while (page && !page.reg[id]) {
      page = page.parent
    }
    if (page) return page
  }
  return null
}
export const getPageRef = (
  page: Leaf | null,
  forkPage: Scope | null | void,
  ref: StateRef,
  isGetState: boolean,
) => {
  const pageForRef = getPageForRef(page, ref.id)
  if (pageForRef) return pageForRef.reg[ref.id]
  if (forkPage) {
    initRefInScope(forkPage!, ref, isGetState)
    return forkPage.reg[ref.id]
  }
  return ref
}

/** Introspection api internals */
type Inspector = (stack: Stack, local: Local) => void
let inspector: Inspector
export const setInspector = (newInspector: Inspector) => {
  inspector = newInspector
}

export function launch(config: {
  target: NodeUnit | NodeUnit[]
  params?: any
  defer?: boolean
  queue?: ReturnType<typeof createEffectorQueue>
  page?: Leaf | void | null
  scope?: Scope | void | null
  stack?: Stack | void
  meta?: Record<string, any> | void
}): void
export function launch(unit: NodeUnit, payload?: any, upsert?: boolean): void
export function launch(unit: any, payload?: any, upsert?: boolean) {
  let pageForLaunch = currentPage
  let stackForLaunch = null
  let forkPageForLaunch = forkPage
  let meta: Record<string, any> | undefined
  let effectorQueue: ReturnType<typeof createEffectorQueue> | null = null
  if (unit.target) {
    effectorQueue = unit.queue

    payload = unit.params
    upsert = unit.defer
    meta = unit.meta
    pageForLaunch = 'page' in unit ? unit.page : pageForLaunch
    if (unit.stack) stackForLaunch = unit.stack
    forkPageForLaunch = getForkPage(unit) || forkPageForLaunch
    unit = unit.target
  }
  if (upsert && !effectorQueue) {
    effectorQueue = currentQueue
  }
  if (forkPageForLaunch && forkPage && forkPageForLaunch !== forkPage) {
    forkPage = null
  }

  if (!effectorQueue) {
    console.log('new queue created')
    effectorQueue = createEffectorQueue()
  } else {
    console.log('queue reused')
  }

  /**
   * Init launch queue
   */
  const {barriers, pushFirstHeapItem, pushHeap, deleteMin} = effectorQueue

  if (Array.isArray(unit)) {
    for (let i = 0; i < unit.length; i++) {
      pushFirstHeapItem(
        'pure',
        pageForLaunch,
        getGraph(unit[i]),
        stackForLaunch,
        payload[i],
        forkPageForLaunch,
        meta,
      )
    }
  } else {
    pushFirstHeapItem(
      'pure',
      pageForLaunch,
      getGraph(unit),
      stackForLaunch,
      payload,
      forkPageForLaunch,
      meta,
    )
  }
  if (upsert && !isRoot) return
  /** main execution code */
  const lastStartedState = {
    isRoot,
    currentPage,
    scope: forkPage,
    isWatch,
    isPure,
    currentQueue,
  }
  isRoot = false
  let stop: boolean
  let skip: boolean
  let node: Node
  let value: Layer | undefined
  let page: Leaf | null
  let reg: Record<string, StateRef> | undefined
  kernelLoop: while ((value = deleteMin())) {
    const {idx, stack, type} = value
    node = stack.node
    currentPage = page = stack.page
    forkPage = getForkPage(stack)
    currentQueue = effectorQueue
    if (page) reg = page.reg
    else if (forkPage) reg = forkPage.reg
    // reg = (page ? page : forkPage ? forkPage : node).reg
    const hasPageReg = !!page
    const hasScopeReg = !!forkPage
    const local: Local = {
      fail: false,
      scope: node.scope,
    }
    stop = skip = false
    for (let stepn = idx; stepn < node.seq.length && !stop; stepn++) {
      const step = node.seq[stepn]
      if (step.order) {
        const {priority, barrierID} = step.order
        const id = barrierID
          ? page
            ? `${page.fullID}_${barrierID}`
            : barrierID
          : 0
        if (stepn !== idx || type !== priority) {
          if (barrierID) {
            if (!barriers.has(id)) {
              barriers.add(id)
              pushHeap(stepn, stack, priority, barrierID)
            }
          } else {
            pushHeap(stepn, stack, priority, 0)
          }
          continue kernelLoop
        }
        barrierID && barriers.delete(id)
      }
      switch (step.type) {
        case 'mov': {
          const data = step.data
          let value
          //prettier-ignore
          switch (data.from) {
            case 'stack': value = getValue(stack); break
            case 'a': /** fall-through case */
            case 'b':
              value = stack[data.from]
              break
            case 'value': value = data.store; break
            case 'store':
              if (reg && !reg[data.store.id]) {
                // if (!page.parent) {
                if (hasPageReg) {
                  const pageForRef = getPageForRef(page, data.store.id)
                  stack.page = page = pageForRef
                  if (pageForRef) {
                    reg = pageForRef.reg
                  } else if (hasScopeReg) {
                    initRefInScope(forkPage!, data.store, false, true, data.softRead)
                    reg = forkPage!.reg
                  } else {
                    reg = undefined //node.reg
                  }
                } else if (hasScopeReg) {
                  /** StateRef in Scope.reg created only when needed */
                  initRefInScope(forkPage!, data.store, false, true, data.softRead)
                } else {
                  // console.error('should not happen')
                  /** StateRef should exists at least in Node itself, but it is not found */
                }
                // }
              }
              // value = getPageRef(page, forkPage, data.store.id, false).current
              value = readRef(reg ? reg[data.store.id] || data.store : data.store)
              break
          }
          //prettier-ignore
          switch (data.to) {
            case 'stack': stack.value = value; break
            case 'a': /** fall-through case */
            case 'b':
              stack[data.to] = value
              break
            case 'store':
              getPageRef(page, forkPage, data.target, false).current = value
              break
          }
          break
        }
        case 'compute':
          const data = step.data
          if (data.fn) {
            isWatch = node.meta.op === 'watch'
            isPure = data.pure
            const computationResult = data.safe
              ? (0 as any, data.fn)(
                  getValue(stack),
                  local.scope,
                  stack,
                  effectorQueue,
                )
              : tryRun(local, data.fn, stack, effectorQueue)
            if (data.filter) {
              /**
               * handled edge case: if step.fn will throw,
               * tryRun will return null
               * thereby forcing that branch to stop
               */
              skip = !computationResult
            } else {
              stack.value = computationResult
            }
            isWatch = lastStartedState.isWatch
            isPure = lastStartedState.isPure
          }
          break
      }
      stop = local.fail || skip
    }
    if (inspector) {
      inspector(stack, local)
    }
    if (!stop) {
      const finalValue = getValue(stack)
      const forkPage = getForkPage(stack)
      forEach(node.next, nextNode => {
        pushFirstHeapItem('child', page, nextNode, stack, finalValue, forkPage)
      })
      if (forkPage) {
        if (node.meta.needFxCounter)
          pushFirstHeapItem(
            'child',
            page,
            forkPage.fxCount,
            stack,
            finalValue,
            forkPage,
          )
        if (node.meta.storeChange)
          pushFirstHeapItem(
            'child',
            page,
            forkPage.storeChange,
            stack,
            finalValue,
            forkPage,
          )
        if (node.meta.warnSerialize)
          pushFirstHeapItem(
            'child',
            page,
            forkPage.warnSerializeNode,
            stack,
            finalValue,
            forkPage,
          )
        const additionalLinks = forkPage.additionalLinks[node.id]
        if (additionalLinks) {
          forEach(additionalLinks, nextNode => {
            pushFirstHeapItem(
              'child',
              page,
              nextNode,
              stack,
              finalValue,
              forkPage,
            )
          })
        }
      }
    }
  }
  isRoot = lastStartedState.isRoot
  currentPage = lastStartedState.currentPage
  forkPage = getForkPage(lastStartedState)
  currentQueue = lastStartedState.currentQueue
}

const noopParser = (x: any) => x

export const initRefInScope = (
  scope: Scope,
  sourceRef: StateRef,
  isGetState?: boolean,
  isKernelCall?: boolean,
  softRead?: boolean,
) => {
  const refsMap = scope.reg
  if (refsMap[sourceRef.id]) return
  const sid = sourceRef.sid
  const ref: StateRef = {
    id: sourceRef.id,
    current: sourceRef.initial!,
    meta: sourceRef.meta,
  }

  if (ref.id in scope.values.idMap) {
    ref.current = scope.values.idMap[ref.id]
  } else if (sid && sid in scope.values.sidMap && !(sid in scope.sidIdMap)) {
    const serialize = sourceRef?.meta?.serialize
    const parser =
      scope.fromSerialize && serialize !== 'ignore'
        ? serialize?.read || noopParser
        : noopParser
    ref.current = parser(scope.values.sidMap[sid])
  } else {
    if (sourceRef.before && !softRead) {
      let isFresh = false
      const needToAssign = isGetState || !sourceRef.noInit || isKernelCall
      forEach(sourceRef.before, cmd => {
        switch (cmd.type) {
          case 'map': {
            const from = cmd.from
            if (from || cmd.fn) {
              if (from) initRefInScope(scope, from, isGetState, isKernelCall)
              if (needToAssign) {
                const value = from && refsMap[from.id].current
                ref.current = cmd.fn ? cmd.fn(value) : value
              }
            }
            break
          }
          case 'field': {
            initRefInScope(scope, cmd.from, isGetState, isKernelCall)
            if (!isFresh) {
              isFresh = true
              if (Array.isArray(ref.current)) {
                ref.current = [...ref.current]
              } else {
                ref.current = {...ref.current}
              }
            }
            if (needToAssign) {
              const from = refsMap[cmd.from.id]
              ref.current[cmd.field] = refsMap[from.id].current
            }
            break
          }
          // case 'closure':
          //   break
        }
      })
    }
  }
  if (sid) scope.sidIdMap[sid] = sourceRef.id
  refsMap[sourceRef.id] = ref
}

/** try catch for external functions */
const tryRun = (local: Local, fn: Function, stack: Stack, q: any) => {
  try {
    return fn(getValue(stack), local.scope, stack, q)
  } catch (err) {
    console.error(err)
    local.fail = true
    local.failReason = err
  }
}

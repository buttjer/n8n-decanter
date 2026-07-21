// Ambient globals available inside n8n Code nodes ("Run Once for All Items" /
// "Run Once for Each Item"). Pragmatic subset — loose where n8n is dynamic.

interface N8nBinaryData {
  data: string;
  mimeType: string;
  fileName?: string;
  fileExtension?: string;
  fileSize?: string;
  directory?: string;
  id?: string;
  [key: string]: unknown;
}

interface N8nItem {
  json: Record<string, any>;
  binary?: Record<string, N8nBinaryData>;
  pairedItem?: number | { item: number; input?: number };
  error?: Error;
}

interface N8nInput {
  all(branchIndex?: number, runIndex?: number): N8nItem[];
  first(branchIndex?: number, runIndex?: number): N8nItem;
  last(branchIndex?: number, runIndex?: number): N8nItem;
  /** Only in "Run Once for Each Item" mode. */
  item: N8nItem;
  params?: Record<string, any>;
}

interface N8nNodeRef {
  all(branchIndex?: number, runIndex?: number): N8nItem[];
  first(branchIndex?: number, runIndex?: number): N8nItem;
  last(branchIndex?: number, runIndex?: number): N8nItem;
  /**
   * The item on this node paired to the current item ("Run Once for Each
   * Item" context). Non-undefined: a missing pairing throws at runtime, it
   * doesn't yield `undefined`. Mirrors `$input.item`.
   */
  item: N8nItem;
  itemMatching(itemIndex: number): N8nItem;
  params: Record<string, any>;
  context: Record<string, any>;
  isExecuted: boolean;
}

/** Access output of an earlier node: `$("Node Name").all()` */
declare function $(nodeName: string): N8nNodeRef;

declare const $input: N8nInput;
/** Shorthand for the current item's json ("Run Once for Each Item" mode). */
declare const $json: Record<string, any>;
declare const $binary: Record<string, N8nBinaryData>;
declare const $env: Record<string, string | undefined>;

declare const $execution: {
  id: string;
  mode: "test" | "production";
  resumeUrl?: string;
  resumeFormUrl?: string;
  customData?: {
    set(key: string, value: string): void;
    get(key: string): string | undefined;
    setAll(values: Record<string, string>): void;
    getAll(): Record<string, string>;
  };
};

declare const $workflow: { id: string; name: string; active: boolean };
declare const $prevNode: { name: string; outputIndex: number; runIndex: number };
declare const $runIndex: number;
declare const $itemIndex: number;
declare const $nodeVersion: number;
declare const $nodeId: string;
declare const $webhookId: string | undefined;

/** Per-workflow / per-node persisted store. */
declare function $getWorkflowStaticData(type: "global" | "node"): Record<string, any>;

declare function $jmespath(data: unknown, expression: string): any;
declare function $evaluateExpression(expression: string, itemIndex?: number): any;
declare function $if<T, F>(condition: boolean, valueIfTrue: T, valueIfFalse: F): T | F;
declare function $min(...numbers: number[]): number;
declare function $max(...numbers: number[]): number;

/** Legacy helpers */
declare function $items(nodeName?: string, outputIndex?: number, runIndex?: number): N8nItem[];
declare const $node: Record<string, N8nNodeRef>;

/** Luxon DateTime (subset). */
declare class DateTime {
  static now(): DateTime;
  static fromISO(text: string, opts?: object): DateTime;
  static fromMillis(ms: number, opts?: object): DateTime;
  static fromSeconds(seconds: number, opts?: object): DateTime;
  static fromJSDate(date: Date, opts?: object): DateTime;
  static fromFormat(text: string, format: string, opts?: object): DateTime;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
  weekday: number;
  zoneName: string;
  isValid: boolean;
  plus(duration: object | number): DateTime;
  minus(duration: object | number): DateTime;
  startOf(unit: string): DateTime;
  endOf(unit: string): DateTime;
  set(values: object): DateTime;
  setZone(zone: string, opts?: object): DateTime;
  setLocale(locale: string): DateTime;
  diff(other: DateTime, unit?: string | string[], opts?: object): any;
  diffNow(unit?: string | string[], opts?: object): any;
  hasSame(other: DateTime, unit: string): boolean;
  toISO(opts?: object): string | null;
  toISODate(): string | null;
  toISOTime(opts?: object): string | null;
  toFormat(format: string, opts?: object): string;
  toLocaleString(opts?: object): string;
  toMillis(): number;
  toSeconds(): number;
  toJSDate(): Date;
  toUTC(offset?: number, opts?: object): DateTime;
  valueOf(): number;
}

/** Luxon Duration (subset). */
declare class Duration {
  static fromObject(values: object, opts?: object): Duration;
  static fromMillis(ms: number, opts?: object): Duration;
  static fromISO(text: string, opts?: object): Duration;
  years: number;
  quarters: number;
  months: number;
  weeks: number;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  milliseconds: number;
  isValid: boolean;
  as(unit: string): number;
  get(unit: string): number;
  plus(duration: Duration | object | number): Duration;
  minus(duration: Duration | object | number): Duration;
  negate(): Duration;
  normalize(): Duration;
  shiftTo(...units: string[]): Duration;
  set(values: object): Duration;
  toObject(): Record<string, number>;
  toISO(opts?: object): string | null;
  toFormat(format: string, opts?: object): string;
  toHuman(opts?: object): string;
  toMillis(): number;
  valueOf(): number;
}

/** Luxon Interval (subset). */
declare class Interval {
  static fromDateTimes(start: DateTime | Date, end: DateTime | Date): Interval;
  static after(start: DateTime | Date, duration: Duration | object | number): Interval;
  static before(end: DateTime | Date, duration: Duration | object | number): Interval;
  static fromISO(text: string, opts?: object): Interval;
  start: DateTime | null;
  end: DateTime | null;
  isValid: boolean;
  length(unit?: string): number;
  count(unit?: string): number;
  contains(dateTime: DateTime): boolean;
  overlaps(other: Interval): boolean;
  engulfs(other: Interval): boolean;
  isBefore(dateTime: DateTime): boolean;
  isAfter(dateTime: DateTime): boolean;
  set(values: object): Interval;
  splitAt(...dateTimes: DateTime[]): Interval[];
  splitBy(duration: Duration | object | number): Interval[];
  toDuration(unit?: string | string[], opts?: object): Duration;
  toISO(opts?: object): string;
  toFormat(format: string, opts?: object): string;
}

declare const $now: DateTime;
declare const $today: DateTime;

/** Debug logging — surfaces in the n8n execution view. */
declare const console: {
  log(...args: any[]): void;
  error(...args: any[]): void;
  warn(...args: any[]): void;
  info(...args: any[]): void;
  debug(...args: any[]): void;
};

// Shared code for Code nodes: import from a `.ts` node and push bundles it
// into the compiled output (see AGENTS.md "Shared code"). Keep helpers small —
// every importing node carries its own copy. Delete this example freely.

export interface OrderLine {
  qty: number;
  price: number;
}

/** Sum of qty × price across lines, rounded to cents. */
export function total(lines: OrderLine[]): number {
  return Math.round(lines.reduce((sum, l) => sum + l.qty * l.price, 0) * 100) / 100;
}

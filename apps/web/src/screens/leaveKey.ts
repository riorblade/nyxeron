/**
 * Esc on a night screen (guest or gig): opens the Leave dialog, and Esc again closes it (Stay), so the dialog is
 * never a keyboard trap. Once the night is over the summary has no Stay, so Esc changes nothing.
 * Returns the next `leaving` state.
 */
export function escLeaving(leaving: boolean, over: boolean): boolean {
  return over ? leaving : !leaving;
}

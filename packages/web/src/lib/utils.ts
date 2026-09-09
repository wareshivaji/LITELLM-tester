import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge Tailwind classes so the LAST one wins.
 *
 * `clsx` alone would emit both `px-3` and `px-6` and leave the winner to CSS
 * source order, which for equal-specificity utilities is whatever order they
 * happen to sit in the generated stylesheet - so a caller passing `px-6` to
 * override a component's `px-3` gets an unpredictable result.
 * `tailwind-merge` understands that the two occupy the same slot and drops the
 * earlier one.
 *
 * That is what makes a `className` prop on these components meaningful, which
 * every shadcn primitive relies on.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

/**
 * A text field.
 *
 * This exists because `selectClass` was doing three jobs. It was named for the
 * one it was written for, but six `<input>` elements and a `<textarea>` had
 * borrowed it too - it had quietly become "the form control look" without
 * anyone deciding that. Splitting it into `Input`, `Textarea` and
 * `SelectTrigger` is why the constant could be deleted rather than renamed:
 * each control now carries the parts that actually apply to it, and a change to
 * the text-field look no longer silently restyles every dropdown.
 */
function Input({ className, type, ...props }: ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'flex h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-none transition-colors outline-none',
        'placeholder:text-muted-foreground/60 hover:border-ring/50',
        'file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'aria-invalid:border-destructive',
        className,
      )}
      {...props}
    />
  );
}

export { Input };

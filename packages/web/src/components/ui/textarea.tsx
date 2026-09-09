import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

/**
 * The request-body editor.
 *
 * `field-sizing-content` is the substantive change over what it replaces. The
 * old markup pinned a `min-h-[42px]` and left `resize-y` to the user, so a
 * pasted 40-line request body opened as a two-line slot you had to drag - on
 * the one control in the app where seeing the whole payload is the entire
 * point. Browsers that do not support it fall back to the `min-h`/`max-h`
 * pair, which is no worse than before.
 */
function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'mono flex field-sizing-content min-h-16 max-h-[60vh] w-full rounded-md border border-input bg-background px-3 py-2 text-xs leading-relaxed text-foreground transition-colors outline-none',
        'placeholder:text-muted-foreground/60 hover:border-ring/50',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'aria-invalid:border-destructive',
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };

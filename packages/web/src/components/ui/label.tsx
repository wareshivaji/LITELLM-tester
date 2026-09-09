import * as LabelPrimitive from '@radix-ui/react-label';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

/**
 * The small uppercase caption above every control.
 *
 * The tracking and colour were already the app's convention - `text-xs
 * font-medium uppercase tracking-wider text-zinc-500`, copied by hand into
 * `Field` and then again inline wherever a control appeared outside a `Field`.
 * The copies had drifted: some were `tracking-wide`, some `text-zinc-600`.
 *
 * Radix's Label is used rather than a plain `<span>` so clicking the caption
 * focuses its control even when the two are not nested, which matters now that
 * the selects are composed elements rather than a single `<select>` a `<label>`
 * could wrap.
 */
function Label({ className, ...props }: ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(
        'flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground select-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export { Label };

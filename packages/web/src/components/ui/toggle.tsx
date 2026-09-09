import * as TogglePrimitive from '@radix-ui/react-toggle';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';
import { toggleItemVariants } from '@/components/ui/toggle-group';

/**
 * A single on/off control that stays pressed.
 *
 * One user in the app: the Exchange log in the target bar, which was a
 * `<button>` whose only signal of being open was its colour. It is a pressed
 * state, not a navigation or an action, and `aria-pressed` is the thing that
 * says so - a screen reader previously announced "Exchange log, button" whether
 * the panel was open or shut.
 *
 * Shares `toggleItemVariants` with ToggleGroup rather than restating them, so
 * a lone toggle and one inside a group cannot drift apart.
 */
function Toggle({
  className,
  size,
  tone,
  ...props
}: ComponentProps<typeof TogglePrimitive.Root> & {
  size?: 'default' | 'sm';
  tone?: 'default' | 'warn';
}) {
  return (
    <TogglePrimitive.Root
      data-slot="toggle"
      className={cn(toggleItemVariants({ size, tone }), className)}
      {...props}
    />
  );
}

export { Toggle };

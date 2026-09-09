/**
 * The component barrel.
 *
 * This exists so the migration cost nothing at the call sites. Thirteen files
 * imported `{ Card, Empty, Json, StatusPill, ... }` from `../components/ui`
 * back when that resolved to `ui.tsx`; the same specifier now resolves to this
 * directory, and those imports are unchanged. Deleting `ui.tsx` is what makes
 * that unambiguous - a file and a folder of the same name would both answer
 * `./ui`, and which one won would depend on the resolver.
 *
 * shadcn's own generated files import each other by full path
 * (`@/components/ui/button`), never through here, so `shadcn add` keeps working
 * and this barrel does not become something they depend on.
 */

// Primitives — generic, would belong in any app.
export { Badge, badgeVariants } from './badge';
export { Button, buttonVariants } from './button';
export { Checkbox } from './checkbox';
export { Input } from './input';
export { Label } from './label';
export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from './select';
export { Separator } from './separator';
export {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from './table';
export { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs';
export { Textarea } from './textarea';

// The lab's own — these encode something about gateways and verdicts.
export type { CheckStatusLike } from './lab';
export {
  Card,
  Empty,
  Field,
  Json,
  Notice,
  StatusPill,
  VerdictLegend,
  VerdictPill,
  verdictTone,
} from './lab';

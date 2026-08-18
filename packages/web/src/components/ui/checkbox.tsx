import * as React from 'react';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { Check, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Tri-state capable checkbox: `checked` accepts `boolean | 'indeterminate'`. */
export const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      'peer h-4 w-4 shrink-0 rounded-sm border border-neutral-300 shadow-sm outline-none',
      'focus-visible:ring-2 focus-visible:ring-neutral-400',
      'disabled:cursor-not-allowed disabled:opacity-40',
      'data-[state=checked]:bg-neutral-900 data-[state=checked]:border-neutral-900 data-[state=checked]:text-white',
      'data-[state=indeterminate]:bg-neutral-900 data-[state=indeterminate]:border-neutral-900 data-[state=indeterminate]:text-white',
      'dark:border-neutral-700 dark:data-[state=checked]:bg-white dark:data-[state=checked]:border-white dark:data-[state=checked]:text-neutral-900',
      'dark:data-[state=indeterminate]:bg-white dark:data-[state=indeterminate]:border-white dark:data-[state=indeterminate]:text-neutral-900',
      className,
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current">
      {props.checked === 'indeterminate' ? (
        <Minus className="h-3 w-3" />
      ) : (
        <Check className="h-3 w-3" />
      )}
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = 'Checkbox';

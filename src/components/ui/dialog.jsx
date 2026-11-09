import React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

const Dialog = DialogPrimitive.Root;

const DialogTrigger = DialogPrimitive.Trigger;

const DialogPortal = DialogPrimitive.Portal;

const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      // z por encima de la cabecera de la app (z-[70]), del sidebar móvil
      // (z-[76]) y del overlay de búsqueda global (z-[90]/z-[95]), pero por
      // DEBAJO de los toasts (z-[100]): un diálogo alto en móvil queda a 16px
      // del borde superior, o sea DETRÁS de la cabecera — su título y su botón
      // de cerrar quedaban tapados y no había forma de cerrarlo con la X.
      'fixed inset-0 z-96 bg-black/50 backdrop-blur-xs data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
      className
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef(({ className, children, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        // Mobile-safe box: the dialog is vertically centred with translate-y(-50%),
        // so without a height cap a tall form (the entry dialog with recurrence
        // open) grows past BOTH edges of a phone screen with no way to scroll to
        // its Save button. `dvh` — not `vh` — because mobile browsers shrink the
        // visual viewport when the URL bar and the keyboard appear.
        // Side margin + rounded corners at every size: `w-full` used to glue it
        // to both edges below `sm`, which read as a broken full-bleed panel.
        // The margin lives on `w-*` (not `max-w-*`) on purpose: callers override
        // `max-w-md`/`max-w-4xl` and tailwind-merge would drop a base max-w.
        'fixed left-[50%] top-[50%] z-97 grid w-[calc(100%-2rem)] sm:w-full max-w-lg max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain translate-x-[-50%] translate-y-[-50%] gap-4 rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] sm:rounded-lg dark:border-slate-700 dark:bg-slate-800',
        className
      )}
      {...props}
    >
      {children}
      {/* -m-3 p-3: caja táctil de 40px (mínimo en móvil) SIN mover el icono —
          el margen negativo compensa exactamente el padding. */}
      <DialogPrimitive.Close className='absolute right-4 top-4 -m-3 p-3 rounded-sm opacity-70 ring-offset-white transition-opacity hover:opacity-100 focus:outline-hidden focus:ring-2 focus:ring-slate-400 focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-slate-100 data-[state=open]:text-slate-500 dark:ring-offset-slate-900 dark:focus:ring-slate-400 dark:data-[state=open]:bg-slate-800 dark:data-[state=open]:text-slate-400'>
        <X className='h-4 w-4' />
        <span className='sr-only'>Close</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({ className, ...props }) => (
  <div
    className={cn(
      'flex flex-col space-y-1.5 text-center sm:text-left',
      className
    )}
    {...props}
  />
);
DialogHeader.displayName = 'DialogHeader';

const DialogFooter = ({ className, ...props }) => (
  <div
    className={cn(
      'flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2',
      className
    )}
    {...props}
  />
);
DialogFooter.displayName = 'DialogFooter';

const DialogTitle = React.forwardRef(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      'text-lg font-semibold leading-none tracking-tight text-slate-900 dark:text-white',
      className
    )}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-sm text-slate-500 dark:text-slate-400', className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
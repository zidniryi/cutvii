import type { ComponentProps, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface IconButtonProps extends Omit<ComponentProps<typeof Button>, "children" | "aria-label"> {
  label: string;
  icon: ReactNode;
  /** Not implemented yet: renders disabled and says so in the tooltip. */
  comingSoon?: boolean;
}

export function IconButton({ label, icon, comingSoon, disabled, className, ...props }: IconButtonProps) {
  const text = comingSoon ? `${label} — Coming soon` : label;
  return (
    <Tooltip>
      {/* span trigger so the tooltip still shows on disabled buttons */}
      <TooltipTrigger render={<span className="inline-flex" />}>
        <Button
          variant="ghost"
          size="icon"
          aria-label={text}
          disabled={disabled || comingSoon}
          className={cn("pointer-coarse:size-11", className)}
          {...props}
        >
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  );
}

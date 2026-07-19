import type { MouseEvent, ReactNode } from "react";
import { appPathname } from "../routing";

type Props = {
  to: string;
  children: ReactNode;
  className?: string;
  "aria-label"?: string;
};

export function AppLink({ to, children, className, "aria-label": ariaLabel }: Props) {
  const href = appPathname(to);

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }

    event.preventDefault();
    window.history.pushState(null, "", href);
    window.dispatchEvent(new PopStateEvent("popstate"));
  };

  return (
    <a href={href} className={className} aria-label={ariaLabel} onClick={handleClick}>
      {children}
    </a>
  );
}

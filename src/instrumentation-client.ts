// Real user monitoring (REV-74): runs before the application becomes interactive.
import { rumError, rumPageView, rumStart } from "@/lib/rum";

rumStart();
window.addEventListener("error", (event) => rumError("error", event.error));
window.addEventListener("unhandledrejection", (event) =>
  rumError("unhandled_rejection", event.reason),
);

/** Each move between views is one page view. */
export function onRouterTransitionStart(url: string) {
  rumPageView(url);
}

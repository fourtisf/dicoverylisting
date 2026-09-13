import type { ReactNode } from "react";

/**
 * Every page's masthead — the Privé Everywhere grammar
 * ("maksud saya semua tampilan dirubah": the inner pages kept opening with
 * the OLD identity's emoji chip in a mint box, whatever the home did).
 *
 * The signature is typographic now: the title's final word takes the serif
 * italic — the same flourish the hero's "moonshot" carries — the subtitle
 * stacks under it, the controls sit right, and the head closes on a
 * hairline so every page opens the way the home's sections do.
 *
 * `icon` is still accepted so thirteen call sites don't churn; it renders
 * nothing. Passing a new emoji here changes nothing on screen — that is
 * deliberate, not a bug.
 */
export function PageHead({
  icon,
  title,
  sub,
  children,
}: {
  icon?: string;
  title: string;
  sub?: string;
  children?: ReactNode;
}) {
  void icon;
  const words = title.split(" ");
  const last = words.pop() as string;
  return (
    <div className="page-head">
      <div className="ph-main">
        <h2>
          {words.length > 0 && <>{words.join(" ")} </>}
          <em className="hero-serif">{last}</em>
        </h2>
        {sub && <span className="page-sub">{sub}</span>}
      </div>
      {children}
    </div>
  );
}

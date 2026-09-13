import { pathFrom } from "@/lib/format";

/** The 34×16 trend line on a mover row.
 *
 *  It is decoration with a job: three tokens all wearing "+18%" are three
 *  different stories, and the shape is the only thing on that row that says
 *  which. Coloured by the move it belongs to so the row reads as one object
 *  rather than a green pill next to a grey squiggle. */
export function Spark({
  points,
  up,
  w = 34,
  h = 16,
}: {
  points: number[];
  up: boolean;
  w?: number;
  h?: number;
}) {
  // pathFrom divides by (length - 1) — a one-point trend would put the whole
  // line at x = Infinity and render nothing but a console warning.
  if (!points || points.length < 2) return <span className="spark-none" aria-hidden />;
  return (
    <svg className="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden focusable="false">
      <path d={pathFrom(points, w, h, 2)} fill="none" stroke={up ? "var(--mint)" : "var(--red)"} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

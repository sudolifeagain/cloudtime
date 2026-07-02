import { EmptyState, ProgressRow } from "./components";

export type ChartDatum = {
  label: string;
  value: number;
  text: string;
};

export function VerticalBarChart({
  id,
  title,
  description,
  data,
  empty,
}: {
  id: string;
  title: string;
  description: string;
  data: ChartDatum[];
  empty: string;
}) {
  const max = Math.max(...data.map((item) => item.value), 0);
  if (max <= 0) return <EmptyState>{empty}</EmptyState>;

  const width = 720;
  const height = 250;
  const paddingX = 38;
  const paddingTop = 18;
  const paddingBottom = 42;
  const chartWidth = width - paddingX * 2;
  const chartHeight = height - paddingTop - paddingBottom;
  const gap = 6;
  const barWidth = Math.max(8, (chartWidth - gap * (data.length - 1)) / data.length);
  const titleId = `${id}-title`;
  const descId = `${id}-desc`;

  return (
    <div class="space-y-3">
      <svg
        class="h-64 w-full overflow-visible"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-labelledby={`${titleId} ${descId}`}
      >
        <title id={titleId}>{title}</title>
        <desc id={descId}>{description}</desc>
        <line
          x1={paddingX}
          y1={height - paddingBottom}
          x2={width - paddingX}
          y2={height - paddingBottom}
          class="stroke-base-300"
          stroke-width="1"
        />
        {data.map((item, index) => {
          const barHeight = Math.max(2, (item.value / max) * chartHeight);
          const x = paddingX + index * (barWidth + gap);
          const y = paddingTop + chartHeight - barHeight;
          return (
            <g>
              <rect
                x={x}
                y={y}
                width={barWidth}
                height={barHeight}
                rx="3"
                class="fill-primary"
              />
              <text
                x={x + barWidth / 2}
                y={height - 20}
                text-anchor="middle"
                class="fill-base-content/60 text-[10px]"
              >
                {item.label}
              </text>
            </g>
          );
        })}
      </svg>
      <div class="grid gap-2 text-xs text-base-content/60 sm:grid-cols-2 lg:grid-cols-3">
        {data.filter((item) => item.value > 0).slice(-6).map((item) => (
          <div class="flex justify-between gap-3">
            <span>{item.label}</span>
            <span class="font-medium text-base-content">{item.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function RankedBarChart({
  data,
  empty,
}: {
  data: ChartDatum[];
  empty: string;
}) {
  const max = Math.max(...data.map((item) => item.value), 0);
  if (max <= 0) return <EmptyState>{empty}</EmptyState>;

  return (
    <div class="space-y-4">
      {data.map((item) => (
        <ProgressRow
          label={item.label}
          value={item.text}
          percent={max > 0 ? (item.value / max) * 100 : 0}
        />
      ))}
    </div>
  );
}


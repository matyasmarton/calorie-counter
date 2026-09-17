/**
 * TrendChart — dependency-free SVG line chart (react-native-svg).
 * Missing dates arrive as absent points; the polyline breaks at gaps of more
 * than one day instead of drawing a zero. Includes an accessible text
 * summary of the latest value and trend for screen readers.
 */
import { colors, font, spacing } from '@/theme';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { LayoutChangeEvent, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Line, Polyline, Text as SvgText } from 'react-native-svg';

export interface TrendPoint {
  date: string; // YYYY-MM-DD
  value: number;
}

const H = 180;
const PAD_X = 8;
const PAD_Y = 22;

function daysBetween(a: string, b: string): number {
  const da = new Date(`${a}T00:00:00`).getTime();
  const db = new Date(`${b}T00:00:00`).getTime();
  return Math.round((db - da) / 86400000);
}

export function TrendChart({
  points,
  unit,
  color = colors.chart,
}: {
  points: TrendPoint[];
  unit: string;
  color?: string;
}) {
  const [width, setWidth] = useState(320);
  const container = useRef<View>(null);

  /**
   * Width source. `onLayout` is react-native-web's job on web, but it never fires
   * here: RNW creates its shared ResizeObserver before the DOM exists under Expo's
   * web rendering, so the observer is null and no layout event is ever dispatched.
   * On web we measure the host node ourselves; native keeps `onLayout`.
   *
   * The measured View wraps BOTH states so the ref is attached on the first render:
   * a chart that mounts with no points yet would otherwise observe nothing and keep
   * its default width for good.
   */
  useEffect(() => {
    // RNW hands back the host DOM node here; the cast is the boundary.
    const node = container.current as unknown as HTMLElement | null;
    if (!node || typeof node.getBoundingClientRect !== 'function') return;
    const measure = () => {
      const next = Math.round(node.getBoundingClientRect().width);
      if (next > 0) setWidth(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

  const { segments, min, max, last, lastXY } = useMemo(() => {
    if (points.length === 0)
      return { segments: [] as string[][], min: 0, max: 0, last: null, lastXY: { x: 0, y: 0 } };
    const values = points.map((p) => p.value);
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    const pad = hi === lo ? 1 : (hi - lo) * 0.12;
    const yMin = lo - pad;
    const yMax = hi + pad;
    const xFor = (i: number) => PAD_X + (i / Math.max(points.length - 1, 1)) * (width - PAD_X * 2);
    const yFor = (v: number) => H - PAD_Y - ((v - yMin) / (yMax - yMin || 1)) * (H - PAD_Y * 2);

    const segments: string[][] = [];
    let current: string[] = [];
    points.forEach((p, i) => {
      const x = xFor(i);
      const y = yFor(p.value);
      if (i > 0 && daysBetween(points[i - 1]!.date, p.date) !== 1) {
        // gap: missing day(s) — start a new segment instead of connecting
        segments.push(current);
        current = [];
      }
      current.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    });
    segments.push(current);

    const li = points.length - 1;
    return {
      segments,
      min: Math.round(yMin * 10) / 10,
      max: Math.round(yMax * 10) / 10,
      last: points[li]!,
      lastXY: { x: xFor(li), y: yFor(points[li]!.value) },
    };
  }, [points, width]);

  const trend =
    !last || points.length < 2
      ? 'no trend yet'
      : last.value > points[0]!.value
        ? 'rising'
        : last.value < points[0]!.value
          ? 'falling'
          : 'steady';

  return (
    <View ref={container} style={styles.container} onLayout={onLayout}>
      {last ? (
        <>
          <Svg width={width} height={H}>
            {[0.25, 0.5, 0.75].map((f) => (
              <Line
                key={f}
                x1={PAD_X}
                x2={width - PAD_X}
                y1={H * f}
                y2={H * f}
                stroke={colors.chartGrid}
                strokeWidth={1}
              />
            ))}
            <SvgText x={PAD_X} y={14} fontSize={10} fill={colors.textMuted}>
              {max}
            </SvgText>
            <SvgText x={PAD_X} y={H - 6} fontSize={10} fill={colors.textMuted}>
              {min}
            </SvgText>
            {segments.map((seg, i) => (
              <Polyline key={i} points={seg.join(' ')} fill="none" stroke={color} strokeWidth={2.5} />
            ))}
            <Circle cx={lastXY.x} cy={lastXY.y} r={4} fill={color} />
          </Svg>
          <Text accessibilityRole="text" style={styles.summary}>
            Latest: {last.value} {unit} on {last.date}. Range {points.length} day
            {points.length === 1 ? '' : 's'} — {trend}.
          </Text>
        </>
      ) : (
        <View style={styles.emptyBox}>
          <Text style={styles.emptyText}>No data in this range yet.</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.xs },
  emptyBox: {
    height: 80,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyText: { color: colors.textMuted, fontSize: font.caption },
  summary: { fontSize: font.caption, color: colors.textMuted },
});

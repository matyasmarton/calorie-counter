/** Small SVG tab icons (react-native-svg) — no icon font dependency. */
import React from 'react';
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';
import { colors } from '@/theme';

function Icon({ children }: { children: React.ReactNode }) {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={colors.text} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      {children}
    </Svg>
  );
}

export function LogIcon() {
  return (
    <Icon>
      <Rect x="4" y="3" width="16" height="18" rx="2" />
      <Line x1="8" y1="8" x2="16" y2="8" />
      <Line x1="8" y1="12" x2="16" y2="12" />
      <Line x1="8" y1="16" x2="13" y2="16" />
    </Icon>
  );
}

/** A fork: three tines on a handle. */
export function FoodsIcon() {
  return (
    <Icon>
      <Line x1="9.5" y1="2.5" x2="9.5" y2="8" />
      <Line x1="12" y1="2.5" x2="12" y2="8" />
      <Line x1="14.5" y1="2.5" x2="14.5" y2="8" />
      <Line x1="9.5" y1="8" x2="14.5" y2="8" />
      <Line x1="12" y1="8" x2="12" y2="21.5" />
    </Icon>
  );
}

export function HistoryIcon() {
  return (
    <Icon>
      <Rect x="3" y="5" width="18" height="16" rx="2" />
      <Line x1="3" y1="10" x2="21" y2="10" />
      <Line x1="8" y1="3" x2="8" y2="7" />
      <Line x1="16" y1="3" x2="16" y2="7" />
    </Icon>
  );
}

export function HealthIcon() {
  return (
    <Icon>
      <Path d="M12 21s-7.5-4.6-9.3-9.2C1.4 8 3.4 5 6.5 5c2 0 3.4 1.1 4.2 2.4h2.6C14.1 6.1 15.5 5 17.5 5c3.1 0 5.1 3 3.8 6.8C19.5 16.4 12 21 12 21z" />
    </Icon>
  );
}

export function ActivityIcon() {
  return (
    <Icon>
      <Path d="M3 12h3.5l2-5 3 10 2.5-7 1.5 2H21" />
    </Icon>
  );
}

export function SettingsIcon() {
  return (
    <Icon>
      <Circle cx="12" cy="12" r="3" />
      <Path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.2a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.2a1.7 1.7 0 0 0 1 1.5h.1a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.2a1.7 1.7 0 0 0-1.5 1z" />
    </Icon>
  );
}

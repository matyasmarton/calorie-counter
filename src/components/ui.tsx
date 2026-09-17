/**
 * Small shared UI primitives — platform-safe, responsive, no dependencies.
 */
import React, { type ReactNode } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput as RNTextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useApp } from '@/app-context';
import { colors, contentMaxWidth, font, fontDisplay, spacing } from '@/theme';

/**
 * Tiled paper grain, drawn behind the screen content. Decorative only — it never
 * receives touches, and it covers the safe area rather than the scroll content so
 * the texture holds still while the page scrolls. Honours the paper-texture
 * setting, which is on by default.
 */
export function PaperGrain() {
  const { grainOn } = useApp();
  if (!grainOn) return null;
  return (
    <Image
      source={require('../../assets/grain.png')}
      resizeMode="repeat"
      accessible={false}
      style={styles.grain}
    />
  );
}

export function Screen({
  children,
  scroll = true,
  maxWidth = contentMaxWidth,
}: {
  children: ReactNode;
  scroll?: boolean;
  /**
   * Cap for the centered content column. Screens that lay out multiple columns on
   * wide viewports pass a larger value; the default is the mobile reading width.
   */
  maxWidth?: number;
}) {
  const inner = <View style={[styles.content, { maxWidth }]}>{children}</View>;
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <PaperGrain />
      {scroll ? <ScrollView contentContainerStyle={styles.scroll}>{inner}</ScrollView> : inner}
    </SafeAreaView>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  loading = false,
  style,
  testID,
}: {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const bg =
    variant === 'primary'
      ? colors.primary
      : variant === 'danger'
        ? colors.danger
        : variant === 'secondary'
          ? colors.card
          : 'transparent';
  const border = variant === 'secondary' ? colors.border : 'transparent';
  const fg =
    variant === 'primary' || variant === 'danger'
      ? '#fff'
      : variant === 'ghost'
        ? colors.primary
        : colors.text;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || loading}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, borderColor: border },
        pressed && styles.buttonPressed,
        (disabled || loading) && styles.buttonDisabled,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} size="small" />
      ) : (
        <Text style={[styles.buttonLabel, { color: fg }]}>{label}</Text>
      )}
    </Pressable>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
      {error ? <Text style={styles.fieldError}>{error}</Text> : null}
      {hint && !error ? <Text style={styles.fieldHint}>{hint}</Text> : null}
    </View>
  );
}

export function TextInput({
  value,
  onChangeText,
  placeholder,
  keyboardType = 'default',
  autoCapitalize = 'none',
  multiline = false,
  autoFocus = false,
  testID,
}: {
  value: string;
  onChangeText: (t: string) => void;
  placeholder?: string;
  keyboardType?: 'default' | 'numeric' | 'decimal-pad' | 'email-address';
  autoCapitalize?: 'none' | 'sentences' | 'words';
  multiline?: boolean;
  autoFocus?: boolean;
  testID?: string;
}) {
  return (
    <RNTextInput
      style={styles.input}
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={colors.textMuted}
      keyboardType={keyboardType}
      autoCapitalize={autoCapitalize}
      multiline={multiline}
      autoFocus={autoFocus}
      testID={testID}
    />
  );
}

export function Chip({
  label,
  sub,
  selected,
  onPress,
}: {
  label: string;
  sub?: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[styles.chip, selected && styles.chipSelected]}
    >
      <Text style={[styles.chipLabel, selected && styles.chipLabelSelected]}>{label}</Text>
      {sub ? <Text style={styles.chipSub}>{sub}</Text> : null}
    </Pressable>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <View accessibilityRole="alert" style={styles.errorBanner}>
      <Text style={styles.errorBannerText}>{message}</Text>
    </View>
  );
}

export function EmptyState({ title, body }: { title: string; body?: string }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{title}</Text>
      {body ? <Text style={styles.emptyBody}>{body}</Text> : null}
    </View>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  // fontDisplay is read per render (not baked into StyleSheet) so the value set
  // once the font resolves is the one painted.
  return <Text style={[styles.sectionTitle, { fontFamily: fontDisplay }]}>{children}</Text>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  /**
   * Decorative texture: never intercepts touches, and pinned behind the scroll
   * content. Width/height are explicit because an Image sizes itself from the
   * asset's intrinsic pixels on web, which would otherwise leave a 128x128 patch.
   */
  grain: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    opacity: 0.05,
    pointerEvents: 'none',
  },
  scroll: { paddingBottom: spacing.xl },
  content: {
    width: '100%',
    alignSelf: 'center',
    padding: spacing.lg,
    gap: spacing.md,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.md,
  },
  button: {
    borderRadius: 10,
    borderWidth: 1,
    paddingVertical: 12,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  buttonPressed: { opacity: 0.85 },
  buttonDisabled: { opacity: 0.5 },
  buttonLabel: { fontSize: font.body, fontWeight: '600' },
  field: { gap: spacing.xs },
  fieldLabel: { fontSize: font.caption, fontWeight: '600', color: colors.textMuted },
  fieldHint: { fontSize: font.caption, color: colors.textMuted },
  fieldError: { fontSize: font.caption, color: colors.danger },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    fontSize: font.body,
    color: colors.text,
    backgroundColor: colors.card,
  },
  chip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    backgroundColor: colors.card,
  },
  chipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipLabel: { fontSize: font.caption, color: colors.text },
  chipLabelSelected: { color: '#fff', fontWeight: '600' },
  chipSub: { fontSize: 11, color: colors.textMuted, textAlign: 'center' },
  errorBanner: {
    backgroundColor: '#fef2f2',
    borderColor: '#fecaca',
    borderWidth: 1,
    borderRadius: 10,
    padding: spacing.md,
  },
  errorBannerText: { color: colors.danger, fontSize: font.caption },
  empty: { alignItems: 'center', paddingVertical: spacing.xl, gap: spacing.xs },
  emptyTitle: { fontSize: font.body, fontWeight: '600', color: colors.text },
  emptyBody: { fontSize: font.caption, color: colors.textMuted, textAlign: 'center' },
  sectionTitle: { fontSize: font.section, fontWeight: '700', color: colors.text, marginTop: spacing.sm },
});

import type { ReactNode } from "react";
import {
  ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View, type TextInputProps,
} from "react-native";
import { color, space, type } from "./theme";

export function Button({
  label, onPress, kind = "primary", disabled = false, busy = false, accessibilityHint,
}: {
  label: string;
  onPress: () => void;
  kind?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  busy?: boolean;
  accessibilityHint?: string;
}) {
  const inactive = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      {...(accessibilityHint ? { accessibilityHint } : {})}
      accessibilityState={{ disabled: inactive, busy }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        kind === "primary" && styles.primary,
        kind === "secondary" && styles.secondary,
        kind === "danger" && styles.danger,
        (pressed || inactive) && styles.pressed,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={kind === "primary" ? "#fff" : color.ink} />
      ) : (
        <Text style={[styles.buttonText, kind !== "primary" && styles.buttonTextDark, kind === "danger" && styles.dangerText]}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

export function Field({
  label, error, ...props
}: TextInputProps & { label: string; error?: string | null | undefined }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        placeholderTextColor={color.inkFaint}
        style={[styles.input, error ? styles.inputError : null]}
        accessibilityLabel={label}
        {...props}
      />
      {error ? <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text> : null}
    </View>
  );
}

export function Notice({ tone, children }: { tone: "amber" | "red" | "green"; children: ReactNode }) {
  const tint = tone === "amber" ? color.amberTint : tone === "red" ? color.redTint : color.greenTint;
  const ink = tone === "amber" ? color.amber : tone === "red" ? color.red : color.green;
  return (
    <View style={[styles.notice, { backgroundColor: tint, borderColor: ink }]} accessibilityRole="alert">
      {typeof children === "string" ? <Text style={[type.body, { color: ink }]}>{children}</Text> : children}
    </View>
  );
}

export function Card({ children }: { children: ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={type.label}>{title}</Text>
      <View style={{ marginTop: space.sm }}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 52, borderRadius: 8, paddingHorizontal: space.lg,
    alignItems: "center", justifyContent: "center",
  },
  primary: { backgroundColor: color.ink },
  secondary: { backgroundColor: color.canvas, borderWidth: 1, borderColor: color.line },
  danger: { backgroundColor: color.canvas, borderWidth: 1, borderColor: color.red },
  pressed: { opacity: 0.6 },
  buttonText: { color: "#fff", fontSize: 17, fontWeight: "600" },
  buttonTextDark: { color: color.ink },
  dangerText: { color: color.red },
  field: { marginBottom: space.lg },
  fieldLabel: { fontSize: 15, fontWeight: "600", color: color.ink, marginBottom: space.xs },
  input: {
    minHeight: 50, borderWidth: 1, borderColor: color.line, borderRadius: 8,
    paddingHorizontal: space.md, fontSize: 17, color: color.ink, backgroundColor: color.canvas,
  },
  inputError: { borderColor: color.red },
  error: { color: color.red, fontSize: 15, marginTop: space.xs },
  notice: { borderWidth: 1, borderRadius: 8, padding: space.md, marginBottom: space.md },
  card: {
    backgroundColor: color.canvas, borderRadius: 10, borderWidth: 1, borderColor: color.line,
    padding: space.lg, marginBottom: space.md,
  },
  section: { marginBottom: space.xl },
});

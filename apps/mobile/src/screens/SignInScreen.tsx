import { useEffect, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { normalizeServerUrl } from "@opentradesos/field-client";
import { useField } from "../state/FieldProvider";
import { lastSignIn } from "../platform/session";
import { Button, Field, Notice } from "../components/ui";
import { color, space, type } from "../components/theme";

/**
 * Two steps: which server, then who. The server is whatever address the
 * company runs this on, so it is asked for first and on its own, and a
 * mistyped address is caught there rather than reported as a wrong password.
 *
 * `again` is the same screen after a sign in ended with work on the phone:
 * it says that the work is safe, and returns to the day when done.
 */
export function SignInScreen({ again = false, onDone }: { again?: boolean; onDone?: () => void }) {
  const field = useField();
  const [step, setStep] = useState<"server" | "account">("server");
  const [server, setServer] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; field?: string | undefined } | null>(null);

  useEffect(() => {
    void lastSignIn().then((last) => {
      if (!last) return;
      setServer(last.serverUrl);
      setEmail(last.email);
      setStep("account");
    });
  }, []);

  const checked = normalizeServerUrl(server);

  const next = () => {
    if (!checked.ok) {
      setError({ text: checked.error, field: "server" });
      return;
    }
    setServer(checked.url);
    setError(null);
    setStep("account");
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    const outcome = await field.signIn({ server, email, password });
    setBusy(false);
    if (!outcome.ok) {
      setError({ text: outcome.error, field: outcome.field });
      if (outcome.field === "server") setStep("server");
      return;
    }
    setPassword("");
    onDone?.();
  };

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={type.title}>{again ? "Sign in again" : "Sign in"}</Text>
        {again ? (
          <Notice tone="amber">
            Your sign in ended. Everything you recorded is still on this phone and will be sent once you are signed in.
          </Notice>
        ) : null}

        {step === "server" ? (
          <View>
            <Text style={[type.soft, styles.lead]}>
              Enter the address your company uses for OpenTradesOS. The office can tell you what it is.
            </Text>
            <Field
              label="Server address"
              value={server}
              onChangeText={setServer}
              placeholder="ops.yourcompany.com"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              returnKeyType="next"
              onSubmitEditing={next}
              error={error?.field === "server" ? error.text : null}
            />
            <Button label="Continue" onPress={next} />
          </View>
        ) : (
          <View>
            <Text style={[type.soft, styles.lead]}>{server}</Text>
            {checked.ok && checked.insecure ? (
              <Notice tone="amber">
                This address is not encrypted, so your password can be read on the way. Only use it on your own company network.
              </Notice>
            ) : null}
            <Field
              label="Email"
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              keyboardType="email-address"
              textContentType="username"
              error={error?.field === "email" ? error.text : null}
            />
            <Field
              label="Password"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoComplete="current-password"
              textContentType="password"
              returnKeyType="go"
              onSubmitEditing={() => void submit()}
              error={error?.field === "password" ? error.text : null}
            />
            {error && !error.field ? <Notice tone="red">{error.text}</Notice> : null}
            <Button label="Sign in" onPress={() => void submit()} busy={busy} />
            {!again ? (
              <View style={styles.secondary}>
                <Button label="Use a different server" kind="secondary" onPress={() => { setStep("server"); setError(null); }} />
              </View>
            ) : (
              <View style={styles.secondary}>
                <Button label="Not now" kind="secondary" onPress={() => onDone?.()} />
              </View>
            )}
          </View>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.page },
  content: { padding: space.xl, paddingTop: space.xl * 2 },
  lead: { marginTop: space.sm, marginBottom: space.xl },
  secondary: { marginTop: space.md },
});

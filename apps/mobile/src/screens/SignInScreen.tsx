import { useEffect, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { normalizeServerUrl } from "@opentradesos/field-client";
import { useField } from "../state/FieldProvider";
import { lastSignIn } from "../platform/session";
import { Button, Field, Notice } from "../components/ui";
import { color, space, type } from "../components/theme";

/**
 * Two steps: which server, then who, with a password or with a one time
 * code sent by text or email for somebody who has no password or forgot it. The server is whatever address the
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
  /** A password, or a one time code by text or email for somebody who has none or forgot it. */
  const [mode, setMode] = useState<"password" | "code">("password");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState<string | null>(null);
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
    const outcome = mode === "password"
      ? await field.signIn({ server, email, password })
      : await field.signInWithCode({ server, email, code });
    setBusy(false);
    if (!outcome.ok) {
      setError({ text: outcome.error, field: outcome.field });
      if (outcome.field === "server") setStep("server");
      return;
    }
    setPassword("");
    setCode("");
    onDone?.();
  };

  const askForCode = async (channel: "sms" | "email") => {
    setBusy(true);
    setError(null);
    const sent = await field.requestCode({ server, email, channel });
    setBusy(false);
    if (!sent.ok) {
      setError({ text: sent.error, field: sent.field });
      if (sent.field === "server") setStep("server");
      return;
    }
    setCodeSent(sent.message);
  };

  const switchTo = (next: "password" | "code") => {
    setMode(next);
    setError(null);
    setCodeSent(null);
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
            {mode === "password" ? (
              <>
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
                <View style={styles.secondary}>
                  <Button label="Sign in with a code instead" kind="secondary" onPress={() => switchTo("code")} />
                </View>
              </>
            ) : codeSent === null ? (
              <>
                <Text style={[type.soft, styles.lead]}>
                  We send a six digit code to the mobile number the office has for you, or to your email.
                </Text>
                {error && !error.field ? <Notice tone="red">{error.text}</Notice> : null}
                <Button label="Text me a code" onPress={() => void askForCode("sms")} busy={busy} />
                <View style={styles.secondary}>
                  <Button label="Email me a code" kind="secondary" onPress={() => void askForCode("email")} disabled={busy} />
                </View>
                <View style={styles.secondary}>
                  <Button label="Use my password" kind="secondary" onPress={() => switchTo("password")} />
                </View>
              </>
            ) : (
              <>
                <Notice tone="green">{codeSent}</Notice>
                <Field
                  label="Code"
                  value={code}
                  onChangeText={setCode}
                  keyboardType="number-pad"
                  autoComplete="one-time-code"
                  textContentType="oneTimeCode"
                  maxLength={9}
                  returnKeyType="go"
                  onSubmitEditing={() => void submit()}
                  error={error?.field === "code" ? error.text : null}
                />
                {error && !error.field ? <Notice tone="red">{error.text}</Notice> : null}
                <Button label="Sign in" onPress={() => void submit()} busy={busy} />
                <View style={styles.secondary}>
                  <Button label="Send another code" kind="secondary" onPress={() => setCodeSent(null)} />
                </View>
              </>
            )}
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

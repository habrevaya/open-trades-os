import { useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { SIGNATURE_PAD_HTML } from "../lib/signature-pad";
import { Button, Field, Notice } from "./ui";
import { color, space, type } from "./theme";

/**
 * The customer's finger on the glass, and their name, for anything they sign
 * on the technician's phone: an estimate they chose, an invoice they accept.
 * The pad hands back a PNG as a data URL; what is done with it (kept on
 * disk, hashed, recorded before the thing that names it) is the caller's.
 */
export function SignatureBox({ initialName, confirmLabel, onSigned, busy = false }: {
  initialName: string;
  confirmLabel: string;
  onSigned: (dataUrl: string, signerName: string) => Promise<string | null>;
  busy?: boolean;
}) {
  const pad = useRef<WebView>(null);
  const [name, setName] = useState(initialName);
  const [drawn, setDrawn] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const onMessage = async (event: WebViewMessageEvent) => {
    const data = event.nativeEvent.data;
    if (data === "drawn") { setDrawn(true); return; }
    if (data === "empty") { setDrawn(false); setSaving(false); return; }
    const failed = await onSigned(data, name.trim());
    setSaving(false);
    setProblem(failed);
  };

  return (
    <View>
      <Text style={type.soft}>Sign in the box with your finger.</Text>
      <View style={styles.pad}>
        <WebView
          ref={pad}
          source={{ html: SIGNATURE_PAD_HTML }}
          onMessage={(e) => void onMessage(e)}
          scrollEnabled={false}
          originWhitelist={["about:blank"]}
          javaScriptEnabled
          style={{ backgroundColor: "#fff" }}
        />
      </View>
      <Field label="Name of the person signing" value={name} onChangeText={setName} autoCapitalize="words" />
      {problem ? <Notice tone="red">{problem}</Notice> : null}
      <View style={styles.row}>
        <View style={{ flex: 1 }}>
          <Button label="Clear" kind="secondary" onPress={() => pad.current?.injectJavaScript("window.signatureClear(); true;")} />
        </View>
        <View style={{ flex: 2 }}>
          <Button
            label={confirmLabel}
            disabled={!drawn || name.trim() === ""}
            busy={saving || busy}
            onPress={() => { setSaving(true); pad.current?.injectJavaScript("window.signatureSave(); true;"); }}
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  pad: {
    height: 220, borderWidth: 1, borderColor: color.line, borderRadius: 8, overflow: "hidden",
    marginVertical: space.md, backgroundColor: "#fff",
  },
  row: { flexDirection: "row", gap: space.sm },
});

import { useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { useField } from "../state/FieldProvider";
import { SIGNATURE_PAD_HTML } from "../lib/signature-pad";
import { Button, Field, Notice } from "../components/ui";
import { color, space, type } from "../components/theme";
import { Header } from "./VisitScreen";
import type { Navigate } from "../shell/App";

/**
 * The customer signs with a finger. Saved to the phone as a PNG the moment
 * they finish, and sent like a photograph: the record first, the image once
 * the server asks for it.
 */
export function SignatureScreen({ visitId, nav }: { visitId: string; nav: Navigate }) {
  const field = useField();
  const visit = field.view?.day.visits.find((v) => v.id === visitId);
  const pad = useRef<WebView>(null);
  const [name, setName] = useState(visit?.customer.name ?? "");
  const [drawn, setDrawn] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const onMessage = async (event: WebViewMessageEvent) => {
    const data = event.nativeEvent.data;
    if (data === "drawn") { setDrawn(true); return; }
    if (data === "empty") { setDrawn(false); setSaving(false); return; }
    const failed = await field.saveSignature(visitId, data, name);
    setSaving(false);
    if (failed) setProblem(failed);
    else nav.back();
  };

  return (
    <View style={styles.root}>
      <Header title="Signature" onBack={nav.back} />
      <View style={styles.content}>
        <Text style={type.soft}>Ask the customer to sign in the box.</Text>
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
          <View style={{ flex: 1 }}>
            <Button
              label="Save"
              disabled={!drawn}
              busy={saving}
              onPress={() => { setSaving(true); pad.current?.injectJavaScript("window.signatureSave(); true;"); }}
            />
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.page },
  content: { flex: 1, padding: space.lg },
  pad: {
    height: 260, borderWidth: 1, borderColor: color.line, borderRadius: 8, overflow: "hidden",
    marginVertical: space.md, backgroundColor: "#fff",
  },
  row: { flexDirection: "row", gap: space.sm },
});

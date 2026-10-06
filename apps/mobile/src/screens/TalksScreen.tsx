import { useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { recordTalkSignature, type DayTalk } from "@opentradesos/field-client";
import { useField } from "../state/FieldProvider";
import { SIGNATURE_PAD_HTML } from "../lib/signature-pad";
import { Button, Card, Notice } from "../components/ui";
import { color, space, type } from "../components/theme";
import { Header } from "./VisitScreen";
import type { Navigate } from "../shell/App";

/**
 * TOOLBOX TALKS, SIGNED ON THE PHONE
 *
 * The talks this person is on the sheet for, each with what it covered, and a
 * pad to sign on. Signing goes through the queue like everything else: the
 * drawn signature is kept on the phone first, then the signing is sent with
 * it, so a talk signed with no signal is signed when the phone next has one.
 * A sheet the office closed meanwhile refuses it, and that comes back as a
 * problem on the day with the office's reason.
 */
export function TalksScreen({ nav }: { nav: Navigate }) {
  const field = useField();
  const zone = field.session?.timezone ?? "UTC";
  const talks = (field.view?.day.talks ?? []).filter((t) => !t.signedAt);
  return (
    <View style={styles.root}>
      <Header onBack={nav.back} title="Toolbox talks" />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {talks.length === 0 ? <Text style={type.soft}>Nothing waiting for your signature.</Text> : null}
        {talks.map((talk) => <TalkCard key={talk.meetingId} talk={talk} zone={zone} />)}
      </ScrollView>
    </View>
  );
}

function TalkCard({ talk, zone }: { talk: DayTalk; zone: string }) {
  const field = useField();
  const pad = useRef<WebView>(null);
  const [drawn, setDrawn] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const when = new Date(talk.heldAt).toLocaleString("en-US", {
    timeZone: zone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });

  const onMessage = async (event: WebViewMessageEvent) => {
    const data = event.nativeEvent.data;
    if (data === "drawn") { setDrawn(true); return; }
    if (data === "empty") { setDrawn(false); setSaving(false); return; }
    const kept = await field.keepDrawnSignature(data);
    if ("problem" in kept) {
      setProblem(kept.problem);
      setSaving(false);
      return;
    }
    await field.perform((phone) => recordTalkSignature(phone, { meetingId: talk.meetingId, topic: talk.topic, signature: kept }));
    setSaving(false);
  };

  return (
    <Card>
      <Text style={type.heading}>{talk.topic}</Text>
      <Text style={type.soft}>
        {[when, talk.location, talk.ledBy ? `led by ${talk.ledBy}` : null].filter(Boolean).join(", ")}
      </Text>
      {talk.notes ? <Text style={[type.body, { marginTop: space.sm }]}>{talk.notes}</Text> : null}
      {talk.signedHere ? (
        <Notice tone="green">{talk.waiting ? "Signed on this phone. Waiting to send." : "Signed. Thank you."}</Notice>
      ) : talk.cannotSign ? (
        <Text style={[type.soft, { marginTop: space.sm }]}>{talk.cannotSign}</Text>
      ) : (
        <View style={{ marginTop: space.sm }}>
          <Text style={type.soft}>Signing says you were there and heard it.</Text>
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
          {problem ? <Notice tone="red">{problem}</Notice> : null}
          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <Button label="Clear" kind="secondary" onPress={() => pad.current?.injectJavaScript("window.signatureClear(); true;")} />
            </View>
            <View style={{ flex: 1 }}>
              <Button
                label="Sign"
                disabled={!drawn}
                busy={saving}
                onPress={() => { setSaving(true); pad.current?.injectJavaScript("window.signatureSave(); true;"); }}
              />
            </View>
          </View>
        </View>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.page },
  content: { padding: space.lg, paddingBottom: space.xl * 3 },
  pad: {
    height: 200, borderWidth: 1, borderColor: color.line, borderRadius: 8, overflow: "hidden",
    marginVertical: space.md, backgroundColor: "#fff",
  },
  row: { flexDirection: "row", gap: space.sm },
});

import { useState } from "react";
import { Image, Modal, Pressable, SafeAreaView, StyleSheet, Text, View } from "react-native";
import {
  customerFileKind, customerFileLabel, customerFilesToShow, PHOTOS_NOT_LOADED, type DayVisit, type FieldCustomerFile,
} from "@opentradesos/field-client";
import { useField } from "../state/FieldProvider";
import { Button, Notice, Section } from "../components/ui";
import { color, space, type } from "../components/theme";

/**
 * WHAT THE CUSTOMER SENT, ON THE VISIT
 *
 * The photograph of the broken unit or the PDF they sent from their own account
 * before anybody arrives (M05). A photograph is a thumbnail that opens full
 * size; a PDF is a line that opens in whatever on the phone reads PDFs. Both are
 * read from the server with this phone's own sign in when the technician looks,
 * so they need a signal; the line says so when there is none, rather than a blank
 * square. The section is absent when the customer sent nothing, and for somebody
 * whose role cannot read documents, for whom the server sends none.
 */
export function CustomerFilesSection({ visit }: { visit: DayVisit }) {
  const field = useField();
  const { shown, more } = customerFilesToShow(visit.customerFiles);
  const [open, setOpen] = useState<FieldCustomerFile | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [unloaded, setUnloaded] = useState(false);
  if (shown.length === 0) return null;

  const photos = shown.filter((f) => customerFileKind(f) === "photo");
  const others = shown.filter((f) => customerFileKind(f) !== "photo");
  const fullSize = open ? field.fileRequest(open.storageKey) : null;

  return (
    <Section title="From the customer">
      {photos.length > 0 ? (
        <View style={styles.thumbs}>
          {photos.map((file) => {
            const request = field.fileRequest(file.storageKey);
            return (
              <Pressable key={file.id} accessibilityRole="imagebutton" accessibilityLabel={`Open ${customerFileLabel(file)}`}
                         onPress={() => setOpen(file)} style={styles.thumb}>
                {request ? (
                  <Image source={{ uri: request.url, headers: request.headers }} style={styles.thumbImage} resizeMode="cover"
                         accessibilityIgnoresInvertColors onError={() => setUnloaded(true)} />
                ) : null}
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {unloaded ? <Text style={[type.soft, { marginTop: space.sm }]} accessibilityLiveRegion="polite">{PHOTOS_NOT_LOADED}</Text> : null}
      {others.map((file) => customerFileKind(file) === "pdf" ? (
        <View key={file.id} style={{ marginTop: space.sm }}>
          <Button label={`Open ${customerFileLabel(file)}`} kind="secondary" busy={opening === file.id}
                  onPress={async () => {
                    setOpening(file.id);
                    setProblem(await field.openPdf(file));
                    setOpening(null);
                  }} />
        </View>
      ) : (
        <Text key={file.id} style={[type.soft, { marginTop: space.sm }]}>{customerFileLabel(file)} (this phone cannot open it)</Text>
      ))}
      {more > 0 ? <Text style={[type.soft, { marginTop: space.sm }]}>and {more} more, on the job in the office.</Text> : null}
      {problem ? <View style={{ marginTop: space.sm }}><Notice tone="amber">{problem}</Notice></View> : null}

      <Modal visible={open !== null} animationType="fade" onRequestClose={() => setOpen(null)}>
        <SafeAreaView style={styles.full}>
          {open && fullSize ? (
            <Image source={{ uri: fullSize.url, headers: fullSize.headers }} style={styles.fullImage} resizeMode="contain"
                   accessibilityLabel={customerFileLabel(open)} onError={() => setUnloaded(true)} />
          ) : null}
          <View style={styles.close}>
            <Button label="Close" kind="secondary" onPress={() => setOpen(null)} />
          </View>
        </SafeAreaView>
      </Modal>
    </Section>
  );
}

const styles = StyleSheet.create({
  thumbs: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  thumb: {
    width: 88, height: 88, borderRadius: 8, overflow: "hidden", backgroundColor: color.page,
    borderWidth: 1, borderColor: color.line,
  },
  thumbImage: { width: "100%", height: "100%" },
  full: { flex: 1, backgroundColor: "#000" },
  fullImage: { flex: 1, width: "100%" },
  close: { padding: space.lg },
});

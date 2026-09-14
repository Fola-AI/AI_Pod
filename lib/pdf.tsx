// PDF export (PRD §11.1) via @react-pdf/renderer, server-side. Clean reading
// copy: title page with topic/date/roster, speaker-tagged body, disclosure
// footer. No timestamps (operator requirement).

import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  renderToBuffer,
} from '@react-pdf/renderer';
import type { Session } from '@/lib/types';
import { getModel } from '@/config/models';
import { getPersona } from '@/lib/personas';
import { FORMATS } from '@/lib/formats';
import { DISCLOSURE_FOOTER } from '@/lib/export';
import { MODERATOR_ID } from '@/lib/orchestrator';

const styles = StyleSheet.create({
  page: { paddingVertical: 56, paddingHorizontal: 64, fontSize: 11, fontFamily: 'Helvetica', color: '#111', lineHeight: 1.5 },
  title: { fontSize: 22, fontFamily: 'Helvetica-Bold', marginBottom: 16 },
  meta: { fontSize: 10, color: '#555', marginBottom: 4 },
  topic: { fontSize: 12, marginTop: 10, marginBottom: 20 },
  rosterHeading: { fontSize: 12, fontFamily: 'Helvetica-Bold', marginTop: 16, marginBottom: 6 },
  rosterLine: { fontSize: 10, color: '#333', marginBottom: 2 },
  speaker: { fontSize: 10, fontFamily: 'Helvetica-Bold', letterSpacing: 1, marginTop: 14, marginBottom: 3 },
  speakerMod: { color: '#666' },
  body: { fontSize: 11 },
  footer: { position: 'absolute', bottom: 32, left: 64, right: 64, fontSize: 8, color: '#888', textAlign: 'center' },
});

function DebateDocument({ session }: { session: Session }) {
  const { config } = session;
  const date = session.createdAt.slice(0, 10);
  const formatLabel = FORMATS[config.format]?.label ?? config.format;

  return (
    <Document title={config.title}>
      <Page size="A4" style={styles.page}>
        <Text style={styles.title}>{config.title}</Text>
        <Text style={styles.meta}>
          {date}  ·  {formatLabel}  ·  {config.agentCount} participants  ·{' '}
          {session.totalWords.toLocaleString()} words
        </Text>
        <Text style={styles.topic}>{config.topic}</Text>

        <Text style={styles.rosterHeading}>Roster</Text>
        {config.agents.map((a) => (
          <Text key={a.id} style={styles.rosterLine}>
            {a.displayName} — {getPersona(a.personaId)?.name ?? a.personaId} —{' '}
            {getModel(a.modelId)?.displayName ?? a.modelId}
          </Text>
        ))}
        <Text style={styles.rosterLine}>
          {config.moderator.displayName || 'Moderator'} — (moderator) —{' '}
          {getModel(config.moderator.modelId)?.displayName ??
            config.moderator.modelId}
        </Text>

        <View style={{ marginTop: 24 }}>
          {session.turns.map((t) => (
            <View key={t.index} wrap={false}>
              <Text
                style={[
                  styles.speaker,
                  ...(t.speakerId === MODERATOR_ID ? [styles.speakerMod] : []),
                ]}
              >
                {t.speakerDisplayName.toUpperCase()}
              </Text>
              <Text style={styles.body}>{t.text}</Text>
            </View>
          ))}
        </View>

        <Text style={styles.footer} fixed>
          {DISCLOSURE_FOOTER}
        </Text>
      </Page>
    </Document>
  );
}

export async function renderSessionPdf(session: Session): Promise<Buffer> {
  return renderToBuffer(<DebateDocument session={session} />);
}

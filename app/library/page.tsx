'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import type { Character, Persona } from '@/lib/types';
import {
  fetchPersonas,
  createPersona,
  updatePersona,
  deletePersona,
  fetchCharacters,
  createCharacter,
  updateCharacter,
  deleteCharacter,
} from '@/lib/client';

export default function LibraryPage() {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [characters, setCharacters] = useState<Character[]>([]);

  useEffect(() => {
    fetchPersonas().then(setPersonas).catch((e) => toast.error(e.message));
    fetchCharacters().then(setCharacters).catch((e) => toast.error(e.message));
  }, []);

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Characters &amp; personas</h1>
          <p className="text-sm text-muted-foreground">
            Personas are edited here instead of in code. Characters carry continuity across episodes.
          </p>
        </div>
        <Button variant="outline" render={<Link href="/" />}>
          Back
        </Button>
      </div>

      <Tabs defaultValue="personas">
        <TabsList>
          <TabsTrigger value="personas">Personas</TabsTrigger>
          <TabsTrigger value="characters">Characters</TabsTrigger>
        </TabsList>

        <TabsContent value="personas">
          <PersonaList personas={personas} setPersonas={setPersonas} />
        </TabsContent>
        <TabsContent value="characters">
          <CharacterList
            characters={characters}
            setCharacters={setCharacters}
            personas={personas}
          />
        </TabsContent>
      </Tabs>
    </main>
  );
}

function PersonaList({
  personas,
  setPersonas,
}: {
  personas: Persona[];
  setPersonas: (p: Persona[]) => void;
}) {
  async function add() {
    try {
      const p = await createPersona({ name: 'New persona', shortDescription: '' });
      setPersonas([...personas, p]);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  return (
    <div className="mt-4 space-y-4">
      <Button onClick={add}>New persona</Button>
      {personas.map((p) => (
        <PersonaCard
          key={p.id}
          persona={p}
          onSaved={(np) => setPersonas(personas.map((x) => (x.id === np.id ? np : x)))}
          onDeleted={() => setPersonas(personas.filter((x) => x.id !== p.id))}
        />
      ))}
    </div>
  );
}

function PersonaCard({
  persona,
  onSaved,
  onDeleted,
}: {
  persona: Persona;
  onSaved: (p: Persona) => void;
  onDeleted: () => void;
}) {
  const [draft, setDraft] = useState(persona);
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(persona);

  async function save() {
    setSaving(true);
    try {
      onSaved(await updatePersona(persona.id, draft));
      toast.success('Saved');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  async function remove() {
    if (!confirm(`Delete "${persona.name}"?`)) return;
    try {
      await deletePersona(persona.id);
      onDeleted();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">
          {draft.name}{' '}
          {persona.isBuiltIn && <Badge variant="outline" className="ml-1 text-[10px]">built-in</Badge>}
        </CardTitle>
        <div className="flex gap-2">
          <Button size="sm" onClick={save} disabled={!dirty || saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
          <Button size="sm" variant="ghost" onClick={remove}>
            Delete
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <Field label="Name">
          <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </Field>
        <Field label="Short description (shown in the picker)">
          <Input
            value={draft.shortDescription}
            onChange={(e) => setDraft({ ...draft, shortDescription: e.target.value })}
          />
        </Field>
        <Field label="System prompt fragment">
          <Textarea
            rows={3}
            value={draft.systemPromptFragment}
            onChange={(e) => setDraft({ ...draft, systemPromptFragment: e.target.value })}
          />
        </Field>
        <Field label="Speaking style">
          <Textarea
            rows={2}
            value={draft.speakingStyle}
            onChange={(e) => setDraft({ ...draft, speakingStyle: e.target.value })}
          />
        </Field>
      </CardContent>
    </Card>
  );
}

function CharacterList({
  characters,
  setCharacters,
  personas,
}: {
  characters: Character[];
  setCharacters: (c: Character[]) => void;
  personas: Persona[];
}) {
  async function add() {
    try {
      const c = await createCharacter({
        displayName: 'New character',
        defaultPersonaId: personas[0]?.id ?? '',
      });
      setCharacters([...characters, c]);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  return (
    <div className="mt-4 space-y-4">
      <Button onClick={add}>New character</Button>
      {characters.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No characters yet. A character is a reusable name + default persona + voice, plus notes
          and catchphrases you fill in over time.
        </p>
      )}
      {characters.map((c) => (
        <CharacterCard
          key={c.id}
          character={c}
          personas={personas}
          onSaved={(nc) => setCharacters(characters.map((x) => (x.id === nc.id ? nc : x)))}
          onDeleted={() => setCharacters(characters.filter((x) => x.id !== c.id))}
        />
      ))}
    </div>
  );
}

function CharacterCard({
  character,
  personas,
  onSaved,
  onDeleted,
}: {
  character: Character;
  personas: Persona[];
  onSaved: (c: Character) => void;
  onDeleted: () => void;
}) {
  const [draft, setDraft] = useState(character);
  const [phrases, setPhrases] = useState(character.catchphrases.join('\n'));
  const [saving, setSaving] = useState(false);
  const dirty =
    JSON.stringify(draft) !== JSON.stringify(character) ||
    phrases !== character.catchphrases.join('\n');

  async function save() {
    setSaving(true);
    try {
      const catchphrases = phrases
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      onSaved(await updateCharacter(character.id, { ...draft, catchphrases }));
      toast.success('Saved');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  async function remove() {
    if (!confirm(`Delete "${character.displayName}"?`)) return;
    try {
      await deleteCharacter(character.id);
      onDeleted();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">{draft.displayName}</CardTitle>
        <div className="flex gap-2">
          <Button size="sm" onClick={save} disabled={!dirty || saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
          <Button size="sm" variant="ghost" onClick={remove}>
            Delete
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <Field label="Display name">
          <Input
            value={draft.displayName}
            onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
          />
        </Field>
        <Field label="Default persona">
          <select
            className="h-9 w-full rounded-md border bg-transparent px-2 text-sm"
            value={draft.defaultPersonaId}
            onChange={(e) => setDraft({ ...draft, defaultPersonaId: e.target.value })}
          >
            <option value="">(none)</option>
            {personas.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Voice id (ElevenLabs, optional)">
          <Input
            value={draft.voiceId ?? ''}
            onChange={(e) => setDraft({ ...draft, voiceId: e.target.value })}
          />
        </Field>
        <Field label="Running notes (leave empty until the character earns them)">
          <Textarea
            rows={2}
            value={draft.runningNotes}
            onChange={(e) => setDraft({ ...draft, runningNotes: e.target.value })}
          />
        </Field>
        <Field label="Catchphrases (one per line, leave empty for now)">
          <Textarea rows={2} value={phrases} onChange={(e) => setPhrases(e.target.value)} />
        </Field>
      </CardContent>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

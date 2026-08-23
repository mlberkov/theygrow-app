// The artifact builder (L1-P3).
//
// Deliberately PURE: read-out in, bytes out. No clock, no fetch, no plugin, no
// DOM. That is what lets app/tests/export/ build the artifact with this exact
// shipped module under `node` and then read the result blind — the thing under
// test is the code that runs on the device, not a second implementation of it
// that could agree with the tests and disagree with the app.
//
// The file list is not written here. It is read out of declaration.json, in the
// declared order, so the artifact and its own manifest of contents cannot drift
// apart: adding a file means declaring it, and a declared file with no renderer
// fails loudly rather than being silently skipped.

import { EXPORT_CONFIG } from './config.js';
import { ExportError } from './errors.js';
import { renderPdf } from './pdf.js';
import { renderAttachmentsNote, renderReadme } from './readme.js';
import { renderDataset, renderDiary, renderJournal } from './text.js';
import { writeZip } from './zip.js';

const ENCODER = new TextEncoder();

// Zero-case wording, one line per file, kept together so the tone stays
// consistent. Each states a fact about the SOURCE — no records were ever
// written — rather than about the rendering, because a reader with nobody to
// ask cannot tell an empty file from a lost one.
const EMPTY_STATEMENT = Object.freeze({
    'text/participants.txt': 'В этом архиве нет ни одного участника семейного контура.',
    'text/children.txt':
        'Ни один атрибут ребёнка ещё не был записан, поэтому показывать нечего.',
    'text/skills.txt':
        'Ни один навык ещё не был отмечен, поэтому текущего состояния навыков нет.',
    // Rewritten in FIU-P4, and the old wording is worth naming because it was
    // FALSE by the time it mattered: it said the diary "appears in a later
    // version of the app". The diary shipped at DIA-P3 and its records have
    // travelled in this archive ever since — this dataset was declared at L1-P3,
    // ahead of the table having rows. An empty file here means one thing only,
    // and it is a fact about the SOURCE: the participant who made this archive
    // wrote nothing. Another participant's entries are not counted here and
    // never were part of what this file could have shown (scope.diary).
    'text/diary.txt':
        'Записей дневника в этом архиве нет: участник, создавший архив, не написал'
        + ' ни одной. Это не потеря и не сбой при создании архива. Записи других'
        + ' участников семьи сюда не входят по правилу архива, поэтому их'
        + ' отсутствие здесь ничего не говорит о том, есть они у них или нет.',
});

function json(value) {
    return ENCODER.encode(`${JSON.stringify(value, null, 2)}\n`);
}

function text(value) {
    return ENCODER.encode(value.endsWith('\n') ? value : `${value}\n`);
}

function datasetByName(declaration, name) {
    const dataset = declaration.datasets.find((candidate) => candidate.name === name);
    if (!dataset) throw new Error(`the declaration names no dataset "${name}"`);
    return dataset;
}

function buildManifest(declaration, readout, manifest) {
    const counts = {};
    for (const dataset of declaration.datasets) {
        counts[dataset.name] = readout[dataset.name].length;
    }
    // Key order is written out explicitly rather than left to object literal
    // luck, because this file is compared byte-for-byte across exports.
    return {
        format: declaration.format,
        format_version: declaration.format_version,
        // What produced the record. A skill identifier is an opaque string
        // without the canon it was written against, and a schema identifier read
        // from the device says what the data was actually written under rather
        // than what this build believes.
        app_version: manifest.appVersion,
        canon_version: manifest.canonVersion,
        schema_contract: manifest.schemaContract,
        schema_version: manifest.schemaVersion,
        encrypted: false,
        media_included: false,
        scope: {
            kind: declaration.scope.kind,
            participant_id: manifest.selfParticipantId,
        },
        exported_at_utc: manifest.exportedAtUtc,
        counts,
    };
}

function renderFile(entry, declaration, readout, manifest, rendered) {
    switch (entry.path) {
        case 'print/archive.pdf':
            // Built LAST, from the text files this same run already produced —
            // so the print layer is literally the printable form of `text/`
            // rather than a second rendering with opinions of its own. A
            // divergence between the two would be undetectable to a reader.
            return renderPdf({
                font: manifest.assets.font,
                icc: manifest.assets.icc,
                title: declaration.title_ru,
                exportedAtUtc: manifest.exportedAtUtc,
                sections: declaration.files
                    .filter((f) => f.path.startsWith('text/'))
                    .map((f) => ({
                        title: f.title_ru,
                        body: new TextDecoder().decode(rendered.get(f.path)),
                    })),
            });
        case 'README.txt':
            return text(renderReadme(declaration));
        case 'MANIFEST.json':
            return json(buildManifest(declaration, readout, manifest));
        case 'index.json':
            // The declaration travels VERBATIM. A paraphrase would drift from
            // the file the builder actually read, and the artifact's whole claim
            // is that its own copy is sufficient to interpret it.
            return json({ declaration, datasets: readout });
        case 'text/journal.txt':
            return text(renderJournal(declaration, readout));
        // The diary has a renderer of its own for the reason text.js gives at
        // renderDiary: a field block answers "what does this dataset hold", and
        // this file has to answer "what did I write about my child". Named here
        // by path, exactly as the journal is, rather than by a new key in the
        // declaration — the file list is the declaration's business, how one
        // declared file is rendered is the builder's.
        case 'text/diary.txt':
            return text(
                renderDiary(datasetByName(declaration, entry.dataset), readout[entry.dataset], {
                    title: entry.title_ru.toUpperCase(),
                    emptyStatement: EMPTY_STATEMENT[entry.path],
                    scopeStatement: declaration.scope.diary?.statement_ru,
                })
            );
        case 'attachments/README.txt':
            return text(renderAttachmentsNote(declaration));
        default: {
            if (!entry.dataset) {
                throw new Error(`declared file "${entry.path}" has no renderer and no dataset`);
            }
            return text(
                renderDataset(
                    datasetByName(declaration, entry.dataset),
                    readout[entry.dataset],
                    {
                        title: entry.title_ru.toUpperCase(),
                        emptyStatement: EMPTY_STATEMENT[entry.path] ?? 'Записей нет.',
                    }
                )
            );
        }
    }
}

/**
 * Builds the artifact.
 *
 * `manifest` carries the facts the read-out cannot supply: the export time, and
 * the three versions the device holds. Everything else comes out of the
 * declaration and the read-out.
 */
export function buildArtifact({ declaration, readout, manifest }) {
    if (declaration.format !== EXPORT_CONFIG.formatId) {
        throw new Error(
            `declaration format "${declaration.format}" is not ${EXPORT_CONFIG.formatId}`
        );
    }
    if (declaration.format_version !== EXPORT_CONFIG.formatVersion) {
        throw new Error(
            `declaration version ${declaration.format_version} is not`
                + ` ${EXPORT_CONFIG.formatVersion}`
        );
    }
    for (const dataset of declaration.datasets) {
        if (!Array.isArray(readout[dataset.name])) {
            throw new Error(`the read-out is missing declared dataset "${dataset.name}"`);
        }
    }

    const printLayer = declaration.files.some((f) => f.path === 'print/archive.pdf');
    if (printLayer && !(manifest.assets?.font && manifest.assets?.icc)) {
        throw new ExportError(
            'the declaration lists a print layer, so the font and the ICC profile are required'
        );
    }

    // Two passes, because the print layer reads what the first pass produced.
    // The declared order is preserved by rendering into a map keyed on path and
    // emitting in `declaration.files` order at the end.
    const rendered = new Map();
    for (const entry of declaration.files) {
        if (entry.path === 'print/archive.pdf') continue;
        rendered.set(entry.path, renderFile(entry, declaration, readout, manifest, rendered));
    }
    if (printLayer) {
        rendered.set(
            'print/archive.pdf',
            renderFile(
                declaration.files.find((f) => f.path === 'print/archive.pdf'),
                declaration,
                readout,
                manifest,
                rendered
            )
        );
    }

    return writeZip(
        declaration.files.map((entry) => ({ path: entry.path, bytes: rendered.get(entry.path) }))
    );
}

/** The filename offered in the system picker. No child's name, by decision. */
export function artifactFilename(exportedAtUtc) {
    const date = new Date(exportedAtUtc).toISOString().slice(0, 10);
    return EXPORT_CONFIG.filenamePattern.replace('{date}', date);
}

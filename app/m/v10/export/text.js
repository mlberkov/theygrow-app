// The human-readable half of the artifact (L1-P3).
//
// These files are what someone reads when there is no app, no parser and no
// company to ask — so each one carries its own field legend rather than
// deferring to a central glossary. The legend is generated from the same
// declaration the sidecar index embeds, so a renamed field cannot leave a stale
// explanation behind in a file nobody re-reads.
//
// A rendering choice worth naming: nothing here writes the export time. The
// export time lives in MANIFEST.json alone, which is what lets the artifact
// promise that two exports of an unchanged journal differ in one file only.

import { EXPORT_CONFIG } from './config.js';

const RULE = '='.repeat(60);

// A token longer than the line is CUT rather than left to run off the edge
// (FIU-P4). The wrapper used to break on whitespace only, so a word with no
// spaces in it — a link a parent pasted, a long identifier — was emitted whole:
// 300 characters on one line in the text file, and one 300-glyph line in the
// print layer, which lays out what these files contain. This mount's export/pdf.js
// wraps by MEASURED WIDTH but never breaks a word either, and it only ever
// splits an input line, never joins two — so bounding the line here bounds the
// printed page, and that is why the fix lives in this file and not in that one.
//
// Cut by CODE POINT, not by code unit: `slice` on a JavaScript string splits a
// surrogate pair, and half a pair is not a character in any file that claims to
// carry the exact text a parent typed.
function pieces(word, width) {
    const points = Array.from(word);
    if (points.length <= width) return [word];
    const out = [];
    for (let at = 0; at < points.length; at += width) {
        out.push(points.slice(at, at + width).join(''));
    }
    return out;
}

function wrap(text, width = EXPORT_CONFIG.textLineWidth) {
    const limit = Math.max(1, width);
    const out = [];
    for (const paragraph of String(text).split('\n')) {
        let line = '';
        for (const word of paragraph.split(/\s+/).filter(Boolean)) {
            for (const piece of pieces(word, limit)) {
                if (line && Array.from(line).length + 1 + Array.from(piece).length > limit) {
                    out.push(line);
                    line = piece;
                } else {
                    line = line ? `${line} ${piece}` : piece;
                }
            }
        }
        out.push(line);
    }
    return out.join('\n');
}

/** Indents an already-wrapped block, line by line. */
function indent(text, spaces) {
    const pad = ' '.repeat(spaces);
    return text
        .split('\n')
        .map((line) => `${pad}${line}`)
        .join('\n');
}

// An absent value is written as an explicit word rather than an empty space. A
// blank reads as "the exporter lost it"; "не задано" reads as what it is, and
// the field legend says what an absent value means for that column.
function show(value) {
    if (value === null || value === undefined || value === '') return '(не задано)';
    return String(value);
}

function legend(dataset) {
    const lines = [`Набор данных: ${dataset.name}`, '', wrap(dataset.description_ru), '', 'Поля:'];
    for (const column of dataset.columns) {
        lines.push(`  ${column.name}`);
        lines.push(
            wrap(column.description_ru, EXPORT_CONFIG.textLineWidth - 6)
                .split('\n')
                .map((line) => `      ${line}`)
                .join('\n')
        );
    }
    return lines.join('\n');
}

function header(title, dataset) {
    return [RULE, title, RULE, '', legend(dataset), '', RULE, ''].join('\n');
}

// One field per line where the value fits, and the legend's own shape — name on
// its own line, value indented under it — where it does not (FIU-P4).
//
// Before this packet a value was never wrapped at all: `body: <a whole diary
// entry>` was one line however long the entry was, and so was a confirmation
// note. That is not a diary-only defect, which is why the fix is here in the
// shared renderer rather than in the diary's own; a reader opening this file in
// a fixed-width terminal in 2044 should not have to scroll sideways through a
// paragraph. A value containing its own line breaks takes the same branch, so
// the second line of a parent's entry can no longer sit at the same indent as
// the FIELD NAMES around it and read as one of them.
function block(dataset, row, { indent: pad = 2, skip = [] } = {}) {
    const prefix = ' '.repeat(pad);
    const continuation = pad + 4;
    const lines = [];
    for (const column of dataset.columns) {
        if (skip.includes(column.name)) continue;
        const value = show(row[column.name]);
        const oneLine = `${prefix}${column.name}: ${value}`;
        if (!value.includes('\n') && Array.from(oneLine).length <= EXPORT_CONFIG.textLineWidth) {
            lines.push(oneLine);
            continue;
        }
        lines.push(`${prefix}${column.name}:`);
        lines.push(
            indent(wrap(value, EXPORT_CONFIG.textLineWidth - continuation), continuation)
        );
    }
    return lines.join('\n');
}

/**
 * Renders one dataset as a labelled block per row.
 *
 * `emptyStatement` words the ZERO case as a fact about the SOURCE — "there are
 * no diary records in this archive" — never as a fact about the rendering. A
 * reader who cannot ask anyone needs to know whether they are looking at a lost
 * file or at a thing that never existed.
 */
export function renderDataset(dataset, rows, { title, emptyStatement }) {
    const parts = [header(title, dataset)];
    if (!rows.length) {
        parts.push(wrap(emptyStatement), '');
        return parts.join('\n');
    }
    rows.forEach((row, index) => {
        parts.push(`--- ${index + 1} из ${rows.length} ---`);
        parts.push(block(dataset, row));
        parts.push('');
    });
    return parts.join('\n');
}

/**
 * Renders the diary as a diary (FIU-P4).
 *
 * WHY THIS FILE GETS A RENDERER OF ITS OWN. Every other text file answers "what
 * does this dataset hold", and a labelled field block is the right shape for
 * that. This one has to answer "what did I write about my child", and until this
 * packet it answered it as `body: <the entry>` — the parent's own words as the
 * fifth field of a thirteen-field record, between `kind` and `media_ref`. The
 * data was all there and the thing the archive exists to keep was not readable.
 *
 * So the entry comes FIRST, under the day it is about, wrapped as prose; the
 * fields follow it under their own heading, one indent deeper. That ordering is
 * also what stops a line inside an entry from being read as a field of it — a
 * parent who writes "  id: ..." on a line of their own is quoting themselves,
 * not declaring a column, and the file now shows the difference. `index.json`
 * carries the same rows field-by-field for anything that wants to parse them,
 * and the declaration says which of the two is authoritative.
 *
 * The print layer needs no separate work: `build.js` builds it from the `text/`
 * files this pass produces, so the diary is printable because it is readable.
 */
export function renderDiary(dataset, rows, { title, emptyStatement, scopeStatement }) {
    const parts = [header(title, dataset)];
    parts.push(
        wrap(
            'Ниже — записи дневника, набранные так, как их читают: сначала день, о'
                + ' котором запись, потом её текст, потом поля этой же записи. Те же'
                + ' записи лежат в index.json полями, для машинной обработки.'
        ),
        ''
    );
    if (scopeStatement) parts.push(wrap(scopeStatement), '');
    parts.push(RULE, '');

    if (!rows.length) {
        parts.push(wrap(emptyStatement), '');
        return parts.join('\n');
    }

    rows.forEach((row, index) => {
        parts.push(`--- запись ${index + 1} из ${rows.length} — ${show(row.event_date_local)} ---`);
        parts.push('');
        // A media record has no body by construction (the schema's paired CHECK),
        // and the file it points at is not in this archive. Saying that here is
        // the difference between an entry that was empty and one whose content
        // never travelled this channel.
        const body = row.kind === 'media'
            ? 'Запись о медиафайле. Сам файл в архив не входит; на устройстве он'
              + ` находится по ссылке ${show(row.media_ref)}.`
            : show(row.body);
        parts.push(indent(wrap(body, EXPORT_CONFIG.textLineWidth - 4), 4));
        parts.push('');
        parts.push('  поля записи (её текст приведён выше):');
        parts.push(block(dataset, row, { indent: 4, skip: ['body'] }));
        parts.push('');
    });
    return parts.join('\n');
}

/**
 * Renders the journal: every spine row followed by its detail row.
 *
 * The join is written out in full rather than flattened, so the file shows the
 * same two-part structure the declaration describes — a reader comparing the
 * text file against index.json sees one shape, not two.
 */
export function renderJournal(declaration, readout) {
    const spine = declaration.datasets.find((d) => d.name === declaration.join.spine);
    const details = new Map(
        declaration.join.detail_datasets.map((name) => [
            name,
            declaration.datasets.find((d) => d.name === name),
        ])
    );
    const byId = new Map();
    for (const name of declaration.join.detail_datasets) {
        for (const row of readout[name]) {
            byId.set(`${name}:${row[declaration.join.detail_key]}`, row);
        }
    }

    const parts = [header('ЖУРНАЛ ЗАПИСЕЙ', spine)];
    parts.push(wrap(declaration.join.comment_ru), '');
    parts.push(RULE, '');

    const rows = readout[declaration.join.spine];
    if (!rows.length) {
        parts.push(wrap('В журнале нет ни одной записи.'), '');
        return parts.join('\n');
    }

    rows.forEach((row, index) => {
        const kind = row[declaration.join.detail_selector];
        const detail = byId.get(`${kind}:${row[declaration.join.spine_key]}`);
        parts.push(`--- запись ${index + 1} из ${rows.length} ---`);
        parts.push(block(spine, row));
        parts.push(`  детали (набор ${kind}):`);
        parts.push(detail ? block(details.get(kind), detail) : '  (детали отсутствуют)');
        parts.push('');
    });
    return parts.join('\n');
}

export { wrap };

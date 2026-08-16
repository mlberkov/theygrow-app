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

function wrap(text, width = EXPORT_CONFIG.textLineWidth) {
    const out = [];
    for (const paragraph of String(text).split('\n')) {
        let line = '';
        for (const word of paragraph.split(/\s+/).filter(Boolean)) {
            if (line && line.length + 1 + word.length > width) {
                out.push(line);
                line = word;
            } else {
                line = line ? `${line} ${word}` : word;
            }
        }
        out.push(line);
    }
    return out.join('\n');
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

function block(dataset, row) {
    return dataset.columns.map((column) => `  ${column.name}: ${show(row[column.name])}`).join('\n');
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

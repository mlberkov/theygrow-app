// The README a person reads in 2044 (L1-P3).
//
// The intended reader has this file, a computer, and possibly nobody to ask:
// no app installed, no account, and no company still standing. Everything they
// need in order to understand what they are holding has to be in the archive
// itself, which is why this text explains the structure in words rather than
// pointing at documentation that lives somewhere else.
//
// TWO SENTENCES ARE DELIBERATELY BLUNT and are asserted verbatim by
// app/tests/export/test_artifact_shape.py: media is not in the archive, and
// there is no cloud backup of this data. Softening either one is how a parent
// ends up believing they have a backup and finding out otherwise at the worst
// possible moment. They are stated here as well as in the interface, because the
// interface will not exist when this file is opened.

import { EXPORT_CONFIG } from './config.js';
import { wrap } from './text.js';

const RULE = '='.repeat(60);

export function renderReadme(declaration) {
    const sections = [];

    sections.push(RULE, declaration.title_ru.toUpperCase(), RULE, '');

    sections.push(
        wrap(
            'Это архив семейной истории, созданный приложением TheyGrow на телефоне'
                + ' родителя. Он создан по прямой команде человека и хранится там, куда'
                + ' этот человек его положил.'
        ),
        ''
    );

    sections.push('ЧТО ЭТИМ ОТКРЫВАТЬ', '');
    sections.push(
        wrap(
            'Файл архива — обычный .zip. Его открывает любой архиватор и любая'
                + ' операционная система без дополнительных программ. Внутри лежат'
                + ' обычные текстовые файлы в кодировке UTF-8 и файл index.json в формате'
                + ' JSON. Специальная программа не нужна ни для чего.'
        ),
        ''
    );
    sections.push(
        wrap(
            'Начните с каталога text/ — это те же данные, набранные словами и'
                + ' пригодные для чтения глазами. Файл index.json — те же данные для'
                + ' машинной обработки; в нём же лежит раздел declaration с полным'
                + ' описанием всех наборов и всех полей. Файл MANIFEST.json содержит'
                + ' версии и количества записей.'
        ),
        ''
    );

    sections.push(RULE, 'ЧЕГО ЗДЕСЬ НЕТ', RULE, '');
    sections.push(wrap('Фотографии, видео и звукозаписи в архив не входят.'), '');
    sections.push(
        wrap(
            'Каталог attachments/ существует, но пуст. Медиафайлы остаются на'
                + ' устройстве и по этому каналу не передаются. Если в записи дневника'
                + ' указано поле media_ref, это ссылка на файл на том устройстве, а не'
                + ' файл внутри архива.'
        ),
        ''
    );
    sections.push(wrap('Резервной копии этих данных в облаке нет.'), '');
    sections.push(
        wrap(
            'Данные семьи живут на устройстве и нигде больше. Этот архив — не'
                + ' дополнение к облачной копии, а единственная копия, которая существует'
                + ' вне устройства. Если устройство потеряно и архива нет, данные'
                + ' потеряны.'
        ),
        ''
    );

    sections.push(RULE, 'ЧТО ЗДЕСЬ ЕСТЬ', RULE, '');
    sections.push(wrap(declaration.about_ru), '');
    sections.push(wrap(declaration.authoritative_ru), '');
    sections.push('');

    sections.push('Файлы архива:', '');
    for (const file of declaration.files) {
        sections.push(`  ${file.path}`);
        sections.push(
            wrap(file.title_ru, EXPORT_CONFIG.textLineWidth - 6)
                .split('\n')
                .map((line) => `      ${line}`)
                .join('\n')
        );
    }
    sections.push('');

    sections.push('Наборы данных:', '');
    for (const dataset of declaration.datasets) {
        const kind = dataset.kind === 'derived' ? 'вычисленный' : 'первичный';
        sections.push(`  ${dataset.name} (${kind}) — ${dataset.title_ru}`);
        sections.push(
            wrap(dataset.description_ru, EXPORT_CONFIG.textLineWidth - 6)
                .split('\n')
                .map((line) => `      ${line}`)
                .join('\n')
        );
    }
    sections.push('');

    sections.push(RULE, 'ЧТО ВХОДИТ В АРХИВ, А ЧТО НЕТ', RULE, '');
    sections.push(wrap(declaration.scope.statement_ru), '');

    sections.push(RULE, 'КАК СВЯЗАНЫ ЗАПИСИ', RULE, '');
    sections.push(wrap(declaration.join.comment_ru), '');
    sections.push(
        wrap(
            'Записи журнала упорядочены по паре (entry_at_utc, id) — по моменту'
                + ' внесения, а при совпадении по идентификатору. Порядок появления'
                + ' записей на конкретном устройстве в архив не входит: он у разных'
                + ' устройств разный даже при одинаковой истории.'
        ),
        ''
    );
    sections.push(
        wrap(
            'Время во всех полях с окончанием _utc — это миллисекунды, прошедшие с'
                + ' полуночи 1 января 1970 года по UTC. Поля с окончанием'
                + ' _utc_offset_min — сдвиг местного времени от UTC в минутах в тот'
                + ' момент. Даты вида ГГГГ-ММ-ДД — местные календарные даты.'
        ),
        ''
    );

    // L1-P4. Read this section as a correction to the dates above it, because
    // that is what it is. Part of this history was carried in from an earlier
    // version of the app that stored marks with no date at all, and the schema
    // has no nullable slot for the date — so those entries wear the date they
    // were imported on. Left unsaid, a reader in 2044 would open text/skills.txt
    // and find three hundred skills mastered on a single afternoon.
    sections.push(RULE, 'О ДАТАХ: ЧАСТЬ ЗАПИСЕЙ ПЕРЕНЕСЕНА', RULE, '');
    sections.push(wrap(declaration.provenance.statement_ru), '');

    sections.push(RULE, 'ПОЧЕМУ АРХИВ НЕ ЗАШИФРОВАН', RULE, '');
    sections.push(
        wrap(
            'Шифрование требует ключа, а ключ через десятилетия теряется раньше,'
                + ' чем сами данные. Этот архив должен читаться без ключа, без пароля,'
                + ' без учётной записи и без интернета — поэтому он открытый. Храните'
                + ' его так же бережно, как хранили бы бумажный семейный альбом: любой,'
                + ' кто получит файл, прочитает его.'
        ),
        ''
    );

    sections.push(RULE, 'ПОВТОРНЫЙ ЭКСПОРТ', RULE, '');
    sections.push(wrap(declaration.determinism.statement_ru), '');
    sections.push(
        wrap(
            'Архив всегда полный. Он никогда не бывает продолжением предыдущего:'
                + ' цепочка из частей теряет всё после первого повреждённого звена, а'
                + ' этот файл существует именно на случай, когда что-то уже пошло не'
                + ' так.'
        ),
        ''
    );

    sections.push(RULE, '');
    sections.push(
        wrap(
            `Формат: ${declaration.format}, версия ${declaration.format_version}.`
                + ' Точные версии приложения, справочника навыков и схемы данных'
                + ' записаны в MANIFEST.json.'
        ),
        ''
    );

    return sections.join('\n');
}

export function renderAttachmentsNote(declaration) {
    return [
        RULE,
        'КАТАЛОГ ВЛОЖЕНИЙ',
        RULE,
        '',
        wrap(declaration.media.statement_ru),
        '',
        wrap(
            'Этот каталог существует для того, чтобы структура архива не менялась,'
                + ' когда в ней появятся вложения. Сегодня он пуст, и это не признак'
                + ' ошибки при создании архива.'
        ),
        '',
        wrap(
            'Медиафайлы остаются на устройстве. Запись дневника с полем media_ref'
                + ' ссылается на файл на том устройстве; сам файл по этому каналу не'
                + ' передаётся.'
        ),
        '',
    ].join('\n');
}

"""Read-only audit of the supplied export; never extracts question content."""
import argparse
from collections import Counter, defaultdict
import csv
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import uuid
import zipfile
from urllib.parse import urlsplit

PREFIX = 'platform_83/'
EXPECTED = dict(sections=14, questions=961, answers=4143, images=78,
                text_explanations=960, explanation_links=433)


def audit(path, check_images=True):
    errors, checks = [], Counter()
    details = defaultdict(list)

    def check(ok, code, context=''):
        checks[code] += 1
        if not ok:
            errors.append(dict(check=code, context=str(context)))

    def unique_uuid(values, label):
        check(len(values) == len(set(values)), label + '_unique')
        for value in values:
            try:
                check(str(uuid.UUID(value)) == value, label + '_uuid', value)
            except (ValueError, TypeError, AttributeError):
                check(False, label + '_uuid', value)

    def scalar(value):
        if isinstance(value, bool):
            return str(value)
        return '' if value is None else str(value)

    with zipfile.ZipFile(path) as z:
        infos = z.infolist()
        names = [i.filename for i in infos]
        check(len(names) == len(set(names)), 'zip_unique_paths')
        for i in infos:
            p = PurePosixPath(i.filename)
            check(not p.is_absolute() and '..' not in p.parts and '\\' not in i.filename
                  and not stat.S_ISLNK(i.external_attr >> 16), 'zip_safe_path', i.filename)
        # Bound processing of this known export and fail before reading oversized content.
        if sum(i.file_size for i in infos) > 100_000_000:
            raise ValueError('Archive exceeds 100 MB uncompressed limit')
        check(z.testzip() is None, 'zip_crc')

        def read(name):
            return z.read(PREFIX + name)

        def load(name):
            return json.loads(read(name))

        data = load('questions.json')
        sections, questions = data['sections'], data['questions']
        answers = [a for q in questions for a in q['answers']]
        manifest = load('images_manifest.json')
        raw = load('raw/pack_data.json')
        hashes = load('sha256.json')
        check(set(hashes) == {n.removeprefix(PREFIX) for n in names
                              if n != PREFIX + 'sha256.json'}, 'hash_inventory')
        for name, digest in hashes.items():
            check(PREFIX + name in names and hashlib.sha256(read(name)).hexdigest() == digest,
                  'sha256', name)
        unique_uuid([s['section_id'] for s in sections], 'sections')
        unique_uuid([q['question_id'] for q in questions], 'questions')
        unique_uuid([a['answer_id'] for a in answers], 'answers')
        section_map = {s['section_id']: s for s in sections}
        question_map = {q['question_id']: q for q in questions}
        check([s['section_order'] for s in sections] == list(range(1, len(sections)+1)), 'section_order')
        check([q['section_order'] for q in questions] == sorted(q['section_order'] for q in questions),
              'question_section_order')
        for s in sections:
            sq = [q for q in questions if q['section_id'] == s['section_id']]
            check(len(sq) == s['question_count'], 'section_count', s['section_id'])
            check([q['question_order'] for q in sq] == list(range(1, len(sq)+1)),
                  'question_order', s['section_id'])
        for q in questions:
            qid = q['question_id']
            s = section_map.get(q['section_id'])
            check(s is not None, 'question_section_link', qid)
            if s:
                check(all(q[k] == s[k] for k in ['section_order', 'section_title']), 'section_metadata', qid)
            check(bool(q['text'].strip()), 'question_text', qid)
            check(bool(q['answers']), 'answers_nonempty', qid)
            check(all(type(a['is_correct']) is bool for a in q['answers']), 'boolean_key', qid)
            check(sum(a['is_correct'] is True for a in q['answers']) == 1, 'one_correct_answer', qid)
            check(all(a['text'].strip() for a in q['answers']), 'answer_text', qid)
            check([a['answer_order'] for a in q['answers']] == list(range(1, len(q['answers'])+1)),
                  'answer_order', qid)
            check(not q['disabled'] and not q['deleted'] and not any(a['deleted'] for a in q['answers']),
                  'active_records', qid)
            if any(a['answer_order'] != a['answer_code'] for a in q['answers']):
                details['answer_order_code_differences'].append(dict(
                    question_id=qid, answers=[{k:a[k] for k in ['answer_id','answer_order','answer_code','is_correct']}
                                              for a in q['answers']]))
            if q['question_order'] != q['question_code']:
                details['question_order_code_differences'].append(qid)
            if any(re.search(r'вариант\w*\s+\d', a['text'], re.I) for a in q['answers']):
                details['numeric_variant_references'].append(qid)
                # Such answers must retain identity/order, including when the key is not at its code position.
                correct = next((a for a in q['answers'] if a['is_correct'] is True), None)
                check(correct is not None and q['answers'][correct['answer_order']-1]['answer_id'] == correct['answer_id'],
                      'numeric_reference_key_identity', qid)
            if not q['explanation'].strip():
                details['empty_explanations'].append(qid)
            check(bool(q['explanation'].strip() or q['explanation_url']), 'any_explanation', qid)
            if q['explanation_url']:
                u = urlsplit(q['explanation_url'])
                check(u.scheme in ('https','http') and bool(u.hostname) and not u.username,
                      'explanation_url', qid)
            for field in ['text','explanation']:
                if re.search(r'<[a-zA-Z/][^>]*>', q[field]):
                    details['html_fields'].append(dict(question_id=qid, field=field))
            for a in q['answers']:
                if re.search(r'<[a-zA-Z/][^>]*>', a['text']):
                    details['html_fields'].append(dict(answer_id=a['answer_id'], field='text'))
        # Compare every exported field to each independent CSV representation.
        for filename, records in [('sections.csv',sections), ('questions.csv',questions),
                                  ('answers.csv',[dict(a,question_id=q['question_id']) for q in questions for a in q['answers']])]:
            rows = list(csv.DictReader(io.StringIO(read(filename).decode('utf-8-sig')), delimiter=';'))
            check(len(rows) == len(records), 'csv_count', filename)
            for row, record in zip(rows, records):
                for k,v in row.items():
                    if k == 'answers_json':
                        ok = json.loads(v) == record['answers']
                    elif k == 'image_pngs_json':
                        ok = json.loads(v) == record['image_pngs']
                    elif k == 'correct_answer_orders':
                        ok = v == ','.join(str(a['answer_order']) for a in record['answers'] if a['is_correct'])
                    else:
                        ok = k in record and v == scalar(record.get(k))
                    check(ok, 'csv_field', filename + ':' + str(record.get('question_id',record.get('section_id'))) + ':' + k)
        # Check source owner relationships, exact texts, keys and array ordering.
        check([s['uuid'] for s in raw] == [s['section_id'] for s in sections], 'raw_section_order')
        raw_questions = [q for s in raw for q in s['questions']]
        check([q['uuid'] for q in raw_questions] == [q['question_id'] for q in questions], 'raw_question_order')
        for rs, s in zip(raw, sections):
            check(rs['owner'] == data['pack']['uuid'], 'raw_pack_owner', s['section_id'])
            check(rs['code'] == s['section_code'] and rs['text'] == s['section_title'], 'raw_section_fields', s['section_id'])
            for rq in rs['questions']:
                q = question_map.get(rq['uuid'])
                if q is None:
                    check(False,'raw_missing_question',rq['uuid'])
                    continue
                check(rq['owner'] == q['section_id'] == s['section_id'], 'raw_question_owner', rq['uuid'])
                fields = dict(text='text',code='question_code',comment_text='explanation',comment_url='explanation_url',
                              not_mix='keep_answer_order',image_attached='image_attached',comment_attached='comment_archive_attached',
                              disabled='disabled',delete_mark='deleted',uptime='updated_at')
                check(all(rq[k] == q[v] for k,v in fields.items()), 'raw_question_fields', rq['uuid'])
                check([a['uuid'] for a in rq['answers']] == [a['answer_id'] for a in q['answers']], 'raw_answer_order',rq['uuid'])
                for ra,a in zip(rq['answers'],q['answers']):
                    check(ra['owner'] == q['question_id'], 'raw_answer_owner', a['answer_id'])
                    check(all(ra[k] == a[v] for k,v in dict(uuid='answer_id',code='answer_code',text='text',true='is_correct',delete_mark='deleted').items()),
                          'raw_answer_fields', a['answer_id'])
        repeated = defaultdict(list)
        for q in questions:
            repeated[q['text']].append(q['question_id'])
        details['duplicate_text_groups'] = [ids for ids in repeated.values() if len(ids)>1]
        check('\ufffd' not in read('questions.json').decode('utf-8'), 'no_replacement_characters')
        check(load('missing_materials.json') == [], 'no_missing_materials')
        check({m['question_id'] for m in manifest} == {q['question_id'] for q in questions if q['image_attached']}, 'image_question_set')
        check(len(manifest) == len({m['question_id'] for m in manifest}), 'image_unique_links')
        image_formats = Counter()
        decoder = shutil.which('magick') if check_images else None
        if check_images and not decoder:
            raise RuntimeError('ImageMagick (magick) required for image decoding')
        with zipfile.ZipFile(io.BytesIO(read('raw/question_files.zip'))) as source_images:
            check(source_images.testzip() is None, 'source_images_crc')
            check(set(source_images.namelist()) == {m['server_filename'] for m in manifest}, 'source_images_inventory')
            for m in manifest:
                q = question_map.get(m['question_id'])
                check(q is not None and q['image_original'] == m['original_file'] and
                      q['image_pngs'] == [f['file'] for f in m['frames']], 'image_metadata',m['question_id'])
                original = read(m['original_file'])
                check(len(original) == m['bytes'] and hashlib.sha256(original).hexdigest() == m['sha256'], 'image_hash',m['question_id'])
                check(original == source_images.read(m['server_filename']), 'source_image_bytes',m['question_id'])
                image_formats[m['format']] += 1
                if decoder:
                    def convert(blob, args):
                        return subprocess.run([decoder,'-',*args], input=blob, capture_output=True, check=True, timeout=20).stdout
                    meta = convert(original,['-format','%m %w %h %n','info:']).decode().split()
                    check({'BMP2':'BMP', 'BMP3':'BMP'}.get(meta[0], meta[0]) == m['format'] and int(meta[3]) == len(m['frames']), 'image_format_frames',m['question_id'])
                    for frame in m['frames']:
                        png = read(frame['file'])
                        pm = convert(png,['-format','%m %w %h','info:']).decode().split()
                        check(pm == ['PNG',str(frame['width']),str(frame['height'])], 'png_dimensions',m['question_id'])
                        rgb_args = ['-alpha','off','-depth','8','rgb:-']
                        check(convert(original,rgb_args) == convert(png,rgb_args), 'image_pixel_roundtrip',m['question_id'])
        counts = dict(sections=len(sections), questions=len(questions), answers=len(answers), images=len(manifest),
                      text_explanations=sum(bool(q['explanation'].strip()) for q in questions),
                      explanation_links=sum(bool(q['explanation_url']) for q in questions))
        for key,value in EXPECTED.items():
            check(counts[key] == value, 'expected_count', key)
        validation = load('validation.json')
        for k in ['sections','questions','answers','text_explanations','explanation_links']:
            check(validation[k] == counts[k], 'validation_counts', k)
        check(validation['questions_without_text_explanation'] == details['empty_explanations'], 'validation_empty_explanations')
        check(validation['repeated_question_texts'] == {t:len(ids) for t,ids in repeated.items() if len(ids)>1}, 'validation_duplicate_texts')
    return dict(status='passed' if not errors else 'failed', archive_sha256=hashlib.sha256(Path(path).read_bytes()).hexdigest(),
                archive_entries=len(infos), counts=counts, checks=dict(checks), errors=errors,
                image_decoding='checked' if decoder else 'not_checked', image_formats=dict(image_formats),
                summary={k:len(v) for k,v in details.items()}, details=dict(details),
                limitations=['Structural and source-key consistency only; no independent certification of official answer correctness.',
                             'External explanation URLs were not opened. Browser rendering and import idempotency belong to stage 1.'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', nargs='?', default='platform_83_export.zip')
    parser.add_argument('--output', default='reports/archive-audit.json')
    args = parser.parse_args()
    try:
        result = audit(args.archive)
    except (OSError, ValueError, KeyError, TypeError, zipfile.BadZipFile, RuntimeError, subprocess.SubprocessError) as exc:
        result = dict(status='failed', errors=[dict(check='audit_aborted', context=str(exc))])
    target = Path(args.output)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(json.dumps({k:result[k] for k in ['status','counts','summary'] if k in result}, ensure_ascii=False, indent=2))
    print(f'Report: {target}; errors: {len(result["errors"])}')
    raise SystemExit(0 if result['status'] == 'passed' else 1)


if __name__ == '__main__':
    main()

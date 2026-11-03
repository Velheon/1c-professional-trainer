"""Regression checks use the private local archive, without copying its texts into tests."""
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

from scripts.audit_archive import audit, PREFIX

ROOT = Path(__file__).resolve().parents[1]
ARCHIVE = ROOT / 'platform_83_export.zip'


@unittest.skipUnless(ARCHIVE.exists(), 'Private archive required')
class ArchiveAuditTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.baseline = audit(ARCHIVE, check_images=False)

    def changed(self, mutate):
        with zipfile.ZipFile(ARCHIVE) as source:
            files = {i.filename: source.read(i) for i in source.infolist()}
        data = json.loads(files[PREFIX+'questions.json'])
        mutate(data)
        files[PREFIX+'questions.json'] = json.dumps(data, ensure_ascii=False).encode()
        # Temporary files remain inside the project and are removed at the end.
        with tempfile.TemporaryDirectory(dir=ROOT) as tmp:
            target = Path(tmp)/'changed.zip'
            with zipfile.ZipFile(target, 'w') as output:
                for name, blob in files.items():
                    output.writestr(name, blob)
            return audit(target, check_images=False)

    def assert_detected(self, result, check):
        self.assertEqual(result['status'], 'failed')
        self.assertIn(check, {error['check'] for error in result['errors']})

    def test_original_archive_and_key_not_position(self):
        self.assertEqual(self.baseline['errors'], [])
        with zipfile.ZipFile(ARCHIVE) as source:
            q = json.loads(source.read(PREFIX+'questions.json'))['questions'][0]
        correct = next(a for a in q['answers'] if a['is_correct'])
        self.assertEqual(correct['answer_id'], 'beedce6c-fcc8-11ea-8f0f-2016b949cb35')
        self.assertEqual((correct['answer_order'], correct['answer_code']), (5,4))
        self.assertEqual(self.baseline['summary']['numeric_variant_references'],281)

    def test_detects_changed_key_even_when_still_one_correct(self):
        def mutate(data):
            for i,a in enumerate(data['questions'][0]['answers']):
                a['is_correct'] = i == 0
        r = self.changed(mutate)
        self.assert_detected(r, 'raw_answer_fields')
        self.assert_detected(r, 'csv_field')
        self.assert_detected(r, 'sha256')

    def test_detects_multiple_correct_answers(self):
        r = self.changed(lambda d: d['questions'][0]['answers'][0].update(is_correct=True))
        self.assert_detected(r, 'one_correct_answer')

    def test_detects_duplicate_uuid(self):
        r = self.changed(lambda d: d['questions'][0]['answers'][0].update(
            answer_id=d['questions'][0]['answers'][1]['answer_id']))
        self.assert_detected(r, 'answers_unique')

    def test_detects_reordered_answers(self):
        r = self.changed(lambda d: d['questions'][0]['answers'].reverse())
        self.assert_detected(r, 'answer_order')
        self.assert_detected(r, 'raw_answer_order')

    def test_detects_broken_section_relationship(self):
        r = self.changed(lambda d: d['questions'][0].update(section_id='00000000-0000-0000-0000-000000000000'))
        self.assert_detected(r, 'question_section_link')

    def test_detects_executable_url(self):
        r = self.changed(lambda d: d['questions'][0].update(explanation_url='javascript:alert(1)'))
        self.assert_detected(r, 'explanation_url')


if __name__ == '__main__':
    unittest.main()

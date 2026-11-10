import { z } from 'zod'
import type { Question } from '../domain/model'

interface Mechanism {
  id:string
  title:string
  parent?:string
  terms?:RegExp
  section?:number
}

// Patterns are platform vocabulary. The private bank is classified on the device.
export const mechanisms:Mechanism[]=[
  {id:'platform',title:'Общие механизмы платформы',section:1,terms:/конфигураци|информационн.{1,12}баз|платформ|внешн.{1,8}обработк/iu},
  {id:'tools',title:'Инструменты разработки',section:2,terms:/конфигуратор|редактор конфигурац|синтакс.помощник|обновлен.{1,12}конфигурац/iu},
  {id:'designers',title:'Конструкторы',parent:'tools',section:3,terms:/конструктор|мастер создани/iu},
  {id:'debug',title:'Отладка и производительность',parent:'tools',terms:/отладк|точк.{1,8}останов|замер производительност|профилирован/iu},
  {id:'interface',title:'Интерфейс',section:4,terms:/интерфейс|клиентское приложени|панель раздел/iu},
  {id:'forms',title:'Формы',parent:'interface',terms:/форм[аыуеой]|реквизит.{1,12}форм|элемент.{1,8}форм/iu},
  {id:'managed_forms',title:'Управляемые формы',parent:'forms',terms:/управляем.{1,12}форм|данныеформ|контекст.{1,12}сервер|насервере|наклиенте/iu},
  {id:'ordinary_forms',title:'Обычные формы',parent:'forms',terms:/обычн.{1,12}форм|обычн.{1,12}приложени/iu},
  {id:'commands',title:'Командный интерфейс',parent:'interface',terms:/командн.{1,12}интерфейс|команд.{1,12}панел|общ.{1,8}команд|команд.{1,15}раздел/iu},
  {id:'user_tools',title:'Общие инструменты и редакторы',section:5,terms:/текстов.{1,12}документ|калькулятор|календар|полнотекстов.{1,12}поиск/iu},
  {id:'development',title:'Технология разработки',section:6,terms:/хранилищ.{1,12}конфигурац|расширени.{1,12}конфигурац|поставк|поддержк.{1,8}конфигурац/iu},
  {id:'language',title:'Встроенный язык',parent:'development',terms:/встроенн.{1,12}язык|процедур|функци[ияю]|модул[ьяей]|типизац|исключени/iu},
  {id:'access',title:'Права доступа и роли',terms:/прав[ао].{1,12}доступ|ограничени.{1,12}доступ|рол[ьи]|rls|привилегирован|профил.{1,12}безопасност/iu},
  {id:'collaboration',title:'Система взаимодействия',section:7,terms:/систем.{1,12}взаимодействи|обсуждени|видеозвон|контекстн.{1,12}обсужден/iu},
  {id:'objects',title:'Объектная модель',section:8,terms:/объектн.{1,12}модел|метаданн|ссылочн.{1,12}тип|перечислени/iu},
  {id:'catalogs',title:'Справочники',parent:'objects',terms:/справочник|иерархи.{1,12}групп|предопределенн.{1,12}элемент/iu},
  {id:'documents',title:'Документы',parent:'objects',terms:/документ|нумератор|журнал.{1,12}документ/iu},
  {id:'posting',title:'Проведение документов',parent:'documents',terms:/проведен|отмен.{1,12}проведен|движени.{1,12}документ/iu},
  {id:'properties',title:'Планы видов характеристик',parent:'objects',terms:/план.{1,12}видов характеристик|характеристик[аиу]/iu},
  {id:'processes',title:'Бизнес-процессы и задачи',parent:'objects',terms:/бизнес.процесс|карт.{1,12}маршрут|точк.{1,12}маршрут|адресац.{1,12}задач/iu},
  {id:'registers',title:'Регистры',terms:/регистр|набор записей|регистрирующ|регистратор/iu},
  {id:'operational',title:'Оперативный учёт',parent:'registers',section:9,terms:/оперативн.{1,12}уч[её]т|остатк|обороты/iu},
  {id:'information_registers',title:'Регистры сведений',parent:'registers',terms:/регистр.{1,12}сведени|срез.{1,8}последн|срез.{1,8}перв/iu},
  {id:'accumulation',title:'Регистры накопления',parent:'registers',terms:/регистр.{1,12}накоплени|остаткииобороты/iu},
  {id:'accounting',title:'Бухгалтерский учёт',parent:'registers',section:10,terms:/бухгалтерск.{1,12}уч[её]т|субконто|проводк|план.{1,12}счетов|дебет|кредит/iu},
  {id:'tables',title:'Табличная модель',section:11,terms:/таблиц.{1,12}значени|дерев.{1,12}значени|табличн.{1,12}част|табличн.{1,12}модел/iu},
  {id:'queries',title:'Запросы',parent:'tables',terms:/запрос|выбрать.{0,4}из|виртуальн.{1,12}таблиц|временн.{1,12}таблиц/iu},
  {id:'exchange',title:'Интеграция и обмен данными',section:12,terms:/обмен.{1,12}данн|план.{1,12}обмен|распределенн.{1,12}баз|сериализац|http|веб.сервис|xml|json/iu},
  {id:'reporting',title:'Отчёты',section:13,terms:/отч[её]т|группировк|ресурс.{1,12}отч/iu},
  {id:'dcs',title:'Система компоновки данных',parent:'reporting',terms:/компоновк.{1,12}данн|скд|набор.{1,12}данн/iu},
  {id:'printing',title:'Макеты и печатные формы',parent:'reporting',terms:/макет|печатн.{1,12}форм|табличн.{1,12}документ/iu},
  {id:'calculations',title:'Периодические расчёты',parent:'registers',section:14,terms:/регистр.{1,12}расч[её]т|план.{1,12}видов расч|вытеснени|перерасч[её]т|базов.{1,12}период/iu},
  {id:'transactions',title:'Транзакции и блокировки',parent:'development',terms:/транзакци|блокировк|взаимоблокировк/iu},
  {id:'jobs',title:'Фоновые и регламентные задания',parent:'development',terms:/фонов.{1,12}задани|регламентн.{1,12}задани/iu},
]
export const mechanismById=new Map(mechanisms.map(m=>[m.id,m]))
const tag=z.string().refine(id=>mechanismById.has(id),'Неизвестный механизм')
export const classificationSchema=z.object({primary:tag,additional:z.array(tag).max(10)})
  .refine(c=>!c.additional.includes(c.primary)&&new Set(c.additional).size===c.additional.length,'Повторяющиеся механизмы')
export type Classification=z.infer<typeof classificationSchema>

export function classify(question:Question):Classification {
  const correct=question.answers.find(a=>a.is_correct)?.text??''
  const scored=mechanisms.map((m,index)=>{
    const score=(m.terms?.test(question.text)?8:0)+(m.terms?.test(correct)?3:0)+
      (m.terms?.test(question.explanation)?2:0)+(m.section===question.section_order?2:0)
    return {id:m.id,score,index,depth:m.parent?1:0}
  }).sort((a,b)=>b.score-a.score||b.depth-a.depth||a.index-b.index)
  return {primary:scored[0].id,additional:scored.slice(1).filter(x=>x.score>=5).slice(0,3).map(x=>x.id)}
}

export function mechanismIds(classification:Classification):Set<string> {
  const ids=new Set<string>()
  for(const tag of [classification.primary,...classification.additional]) {
    let id:string|undefined=tag
    while(id&&!ids.has(id)) {
      ids.add(id)
      id=mechanismById.get(id)?.parent
    }
  }
  return ids
}

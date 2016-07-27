import * as Config from '../../openag-config.json';
import {html, forward, Effects, Task, thunk} from 'reflex';
import {merge, tagged, tag, batch} from '../common/prelude';
import * as Poll from '../common/poll';
import * as Template from '../common/stache';
import * as Request from '../common/request';
import * as Result from '../common/result';
import * as Unknown from '../common/unknown';
import {cursor} from '../common/cursor';
import {compose, constant} from '../lang/functional';
import * as EnvironmentalDataPoint from '../environmental-data-point';
import * as Chart from '../environments/chart';
// @TODO do proper localization
import {localize} from '../common/lang';

const RECIPE_START = 'recipe_start';
const RECIPE_END = 'recipe_end';

const S_MS = 1000;
const MIN_MS = S_MS * 60;
const HR_MS = MIN_MS * 60;
const DAY_MS = HR_MS * 24;

const POLL_TIMEOUT = 2 * S_MS;
const RETRY_TIMEOUT = 4 * S_MS;

// @FIXME this is a temporary kludge for getting data into the system
// when no recipe start. Get the previous day's data. Range in seconds.
const FALLBACK_START_MS = (Date.now() - DAY_MS);

// Actions

const NoOp = {
  type: 'NoOp'
};

const PollAction = action =>
  action.type === 'Ping' ?
  FetchLatest :
  tagged('Poll', action);

// This is the first fetch we do for the model from the API.
const FetchInfo = {type: 'FetchInfo'};
const Info = tag('Info');

const FetchLatest = {type: 'FetchLatest'};
const Latest = tag('Latest');

const FetchRestore = tag('FetchRestore');
const Restore = tag('Restore');

const PongPoll = PollAction(Poll.Pong);
const MissPoll = PollAction(Poll.Miss);

const ChartAction = tag('Chart');
const ChartData = compose(ChartAction, Chart.Data);
const ChartLoading = compose(ChartAction, Chart.Loading);

const StartRecipe = tag('StartRecipe');
const EndRecipe = tag('EndRecipe');

// Send an alert. We use this to send up problems to be displayed in banner.
const AlertBanner = tag('AlertBanner');
// Suppress a previously sent alert.
const SuppressBanner = {type: 'SuppressBanner'};

// Map an incoming datapoint into an action
const DataPointAction = dataPoint => {
  console.log(DataPoint);
}

// Model init and update

export const init = id => {
  const [poll, pollFx] = Poll.init(POLL_TIMEOUT);
  const [chart, chartFx] = Chart.init();

  return [
    {
      id,
      chart,
      poll,
      recipeStart: null,
      recipeEnd: null
    },
    Effects.batch([
      chartFx.map(ChartAction),
      pollFx.map(PollAction),
      Effects.receive(FetchInfo)
    ])
  ];
};

export const update = (model, action) =>
  action.type === 'NoOp' ?
  [model, Effects.none] :
  action.type === 'Poll' ?
  updatePoll(model, action.source) :
  action.type === 'FetchLatest' ?
  [model, Request.get(templateLatestUrl(model.id)).map(Latest)] :
  action.type === 'FetchRestore' ?
  [model, Request.get(templateRangeUrl(model.id, action.source)).map(Restore)] :
  action.type === 'Restore' ?
  restore(model, action.source) :
  action.type === 'Latest' ?
  updateLatest(model, action.source) :
  action.type === 'FetchInfo' ?
  [model, Request.get(templateLatestUrl(model.id)).map(Info)] :
  action.type === 'Info' ?
  updateInfo(model, action.source) :
  action.type === 'Chart' ?
  updateChart(model, action.source) :
  action.type === 'StartRecipe' ?
  startRecipe(model, action.source) :
  action.type === 'EndRecipe' ?
  endRecipe(model, action.source) :
  Unknown.update(model, action);

const startRecipe = (model, timestamp) =>
  model.recipeStart < timestamp ?
  [
    merge(model, {
      recipeStart: timestamp
    }),
    Effects.none
  ] :
  [model, Effects.none];

const endRecipe = (model, timestamp) =>
  model.recipeStart < timestamp ?
  [
    merge(model, {
      recipeStart: timestamp
    }),
    Effects.none
  ] :
  [model, Effects.none];

const isRowRecipeStart = row => row.value.variable === RECIPE_START;
const isRowRecipeEnd = row => row.value.variable === RECIPE_END;

const findRecipeStartInRecord = record => {
  const row = record.rows.find(isRowRecipeStart);
  // @TODO we should have a fallback.
  return row ? row.value : null;
}

const findRecipeEndInRecord = record => {
  const row = record.rows.find(isRowRecipeEnd);
  // @TODO we should have a fallback.
  return row ? row.value : null;
}

const updateInfo = Result.updater(
  (model, record) => {
    const actions = [];

    const fallback = FALLBACK_START_MS / 1000;
    // Find recipe start and end timestamps (if any)
    const recipeStartTimestamp = findRecipeStartInRecord(record) || fallback;
    const recipeEndTimestamp = findRecipeEndInRecord(record);

    if (recipeStartTimestamp) {
      actions.push(StartRecipe(recipeStartTimestamp));
      actions.push(FetchRestore(recipeStartTimestamp));
    }

    if (recipeEndTimestamp) {
      actions.push(RecipeEnd(recipeEndTimestamp));
    }

    return batch(update, model, actions);
  },
  (model, error) => {
    // Create alert action
    const alertAction = AlertBanner(error);

    const fetchFx = Effects
      .perform(Task.sleep(RETRY_TIMEOUT))
      .map(constant(FetchInfo));

    return [
      model,
      Effects.batch([
        fetchFx,
        Effects.receive(alertAction)
      ])
    ];
  }
);

const updateLatest = Result.updater(
  (model, record) => {
    // @FIXME
    const actions = readRecord(record).map(DataPointAction);
    actions.push(PongPoll);
    return batch(update, model, actions);
  },
  (model, error) => {
    // Send miss poll
    const [next, fx] = update(model, MissPoll);

    // Create alert action
    const action = AlertBanner(error);

    return [
      next,
      // Batch any effect generated by MissPoll with the alert effect.
      Effects.batch([
        fx,
        Effects.receive(action)
      ])
    ];
  }
);

const restore = Result.updater(
  (model, record) => {
    const action = ChartData(readData(record));
    const [next, fx] = update(model, action);

    return [
      next,
      Effects.batch([
        fx,
        // Suppress any banners.
        Effects.receive(SuppressBanner)
      ])
    ];
  },
  (model, error) => {
    const action = AlertBanner(error);

    return [
      model,
      Effects.batch([
        // Wait for a second, then try to restore again.
        Effects.perform(Task.sleep(RETRY_TIMEOUT)).map(FetchRestore),
        Effects.receive(action)
      ])
    ];
  }
);

const updateChart = cursor({
  get: model => model.chart,
  set: (model, chart) => merge(model, {chart}),
  update: Chart.update,
  tag: ChartAction
});

const updatePoll = cursor({
  get: model => model.poll,
  set: (model, poll) => merge(model, {poll}),
  update: Poll.update,
  tag: PollAction
});

// View

export const view = (model, address) =>
  html.div({
    className: 'environment-main'
  }, [
    thunk('chart', Chart.view, model.chart, forward(address, ChartAction))
  ]);

// Helpers

const readRow = row => row.value;
// @FIXME must check that the value returned from http call is JSON and has
// this structure before mapping.
const readRecord = record => record.rows.map(readRow);

const compareByTimestamp = (a, b) =>
  a.timestamp > b.timestamp ? 1 : -1;

const readDataPoint = ({variable, is_desired, timestamp, value}) => ({
  variable,
  timestamp,
  is_desired,
  value: Number.parseFloat(value)
});

const readData = record => {
  const data = readRecord(record).map(readDataPoint);
  data.sort(compareByTimestamp);
  return data;
};

// Create a url string that allows you to GET latest environmental datapoints
// from an environmen via CouchDB.
const templateLatestUrl = (environmentID) =>
  Template.render(Config.environmental_data_point_origin_latest, {
    origin_url: Config.origin_url,
    startkey: JSON.stringify([environmentID]),
    endkey: JSON.stringify([environmentID, {}])
  });

const templateRangeUrl = (environmentID, startTime, endTime) =>
  Template.render(Config.environmental_data_point_origin_range, {
    origin_url: Config.origin_url,
    startkey: JSON.stringify([environmentID, startTime]),
    endkey: JSON.stringify([environmentID, endTime || {}])
  });

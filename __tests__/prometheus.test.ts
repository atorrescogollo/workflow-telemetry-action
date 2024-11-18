import { WorkflowJobType } from '../src/interfaces'

process.env.GITHUB_REPOSITORY = 'test/test'
process.env.GITHUB_RUN_ID = '1'
process.env.GITHUB_SHA = '123456'
process.env.GITHUB_JOB = 'test-job'
process.env.GITHUB_RUN_NUMBER = '1'
process.env.GITHUB_ACTION = 'test-action'
process.env.GITHUB_TOKEN = 'test-token'

import { reportMetricsToPrometheusPushGateway } from '../src/post'
import { TelemetryData } from '../src/stepTracer'

const globalFetch = global.fetch
const currentJobSample = {
  started_at: '2021-08-01T00:00:00Z',
  completed_at: '2021-08-01T01:00:00Z',
  name: 'test-job',
  head_sha: '123456'
  //steps: [], // Not used since we are mocking the telemetry data
} as WorkflowJobType
const telemetryDataSample: TelemetryData[] = [
  {
    number: 1,
    name: 'step1',
    conclusion: 'success',
    startTime: new Date('2021-08-01T00:00:00Z'),
    endTime: new Date('2021-08-01T00:00:01Z')
  },
  {
    number: 2,
    name: 'step2',
    conclusion: 'success',
    startTime: new Date('2021-08-01T00:00:01Z'),
    endTime: new Date('2021-08-01T00:02:00Z')
  }
]

describe('Prometheus Push Gateway', () => {
  afterEach(() => {
    global.fetch = globalFetch
  })

  it('should report metrics to Prometheus Push Gateway', async () => {
    let mocked_calls: any[] = []
    function fetch_mock(
      input: RequestInfo | URL,
      init?: RequestInit
    ): Promise<Response> {
      mocked_calls.push({ input, init })
      return Promise.resolve(new Response())
    }
    global.fetch = fetch_mock

    process.env.INPUT_JOB_STATUS = 'success'
    reportMetricsToPrometheusPushGateway(
      'http://localhost:9091/metrics/job/test-job',
      new Map([['labelname1', 'labelvalue1']]),
      currentJobSample,
      telemetryDataSample
    )

    expect(mocked_calls).toStrictEqual([
      {
        input: 'http://localhost:9091/metrics/job/test-job',
        init: {
          method: 'PUT',
          body: `
# TYPE github_actions_job_duration_ms gauge
# HELP github_actions_job_duration_ms Elapsed time for the job in milliseconds

# TYPE github_actions_job_conclusion gauge
# HELP github_actions_job_conclusion Conclusion of the job. 1 for success, 0 for failure

# TYPE github_actions_step_duration_ms gauge
# HELP github_actions_step_duration_ms Elapsed time for the step in milliseconds

# TYPE github_actions_step_conclusion gauge
# HELP github_actions_step_conclusion Conclusion of the step. 1 for success, 0 for failure

github_actions_job_duration_ms{head_sha="123456",job_conclusion="success",labelname1="labelvalue1"} 3600000
github_actions_job_conclusion{head_sha="123456",job_conclusion="success",labelname1="labelvalue1"} 1

github_actions_step_duration_ms{step_name="step1",step_conclusion="success",head_sha="123456",job_conclusion="success",labelname1="labelvalue1"} 1000
github_actions_step_conclusion{step_name="step1",step_conclusion="success",head_sha="123456",job_conclusion="success",labelname1="labelvalue1"} 1
github_actions_step_duration_ms{step_name="step2",step_conclusion="success",head_sha="123456",job_conclusion="success",labelname1="labelvalue1"} 119000
github_actions_step_conclusion{step_name="step2",step_conclusion="success",head_sha="123456",job_conclusion="success",labelname1="labelvalue1"} 1
`
        }
      }
    ])
  })
})

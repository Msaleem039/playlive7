export interface CricketIdApiResponse<T> {
  success: boolean;
  msg: string;
  status: number;
  data: T;
}

export interface CricketIdSport {
  eid: number;
  ename: string;
  active: boolean;
  tab: boolean;
  isdefault: boolean;
  oid: number;
}

export interface CricketIdMatch {
  match_id: number;
  series_id?: number;
  title?: string;
  short_title?: string;
  status?: string;
  status_note?: string;
  start_time?: string;
  teamA?: string;
  teamB?: string;
  [key: string]: any;
}

export interface CricketIdOdds {
  sid?: string | number;
  runner?: string;
  back?: number | null;
  lay?: number | null;
  status?: string;
  market_id?: string | number;
  [key: string]: any;
}

export interface CricketIdFancy {
  mid?: number;
  name?: string;
  rate?: number | null;
  session?: string;
  line?: string;
  [key: string]: any;
}

export interface CricketIdScore {
  match_id: number;
  batting_team?: string;
  bowling_team?: string;
  score?: string;
  overs?: string;
  wickets?: number;
  striker?: string;
  non_striker?: string;
  bowler?: string;
  status?: string;
  [key: string]: any;
}


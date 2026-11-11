# frozen_string_literal: true

# 构建时从 ORCID 公共 API 同步公开科研成果（含作者列表），供 _includes/orcid-works.html 渲染。
#
# 配置见 _config.yml 的 `orcid:` 段：
#   orcid:
#     enabled: true
#     id: 0000-0000-0000-0000
#     max_works: 50
#     cache_ttl_hours: 6
#
# 行为：
#   1. 优先读 .jekyll-cache/orcid-works-<id>.json（缓存未过期时不再请求网络）；
#   2. 否则请求 works 列表，再逐个拉取作品详情以拿到作者（1 + N 次请求，N <= max_works）；
#   3. 任何一步失败都只打警告，继续使用 _data/orcid_works.yml 里的快照，构建不会中断。

require "json"
require "fileutils"
require "net/http"
require "time"
require "uri"

module Jekyll
  class OrcidWorksGenerator < Generator
    priority :low
    safe true

    API_ROOT = "https://pub.orcid.org/v3.0"
    USER_AGENT = "chirpy-orcid-sync/1.0"

    # ORCID 成果类型 -> 中文标签
    TYPE_LABELS = {
      "journal-article"      => "期刊论文",
      "conference-paper"     => "会议论文",
      "conference-poster"    => "会议海报",
      "conference-abstract"  => "会议摘要",
      "book"                 => "专著",
      "edited-book"          => "编著",
      "book-chapter"         => "书籍章节",
      "dissertation"         => "学位论文",
      "preprint"             => "预印本",
      "working-paper"        => "工作论文",
      "data-set"             => "数据集",
      "software"             => "软件",
      "patent"               => "专利",
      "report"               => "报告",
      "research-tool"        => "科研工具",
      "technical-standard"   => "技术标准",
      "standards-and-policy" => "标准与政策",
      "online-resource"      => "在线资源",
      "website"              => "网站",
      "lecture-speech"       => "学术报告",
      "other"                => "其他"
    }.freeze

    def generate(site)
      conf = site.config["orcid"] || {}
      return if conf["enabled"] == false

      id = normalize_id(conf["id"])
      if id.nil?
        Jekyll.logger.warn "ORCID:", "orcid.id 缺失或格式不正确，跳过同步"
        return
      end

      payload = load_payload(site, id, ttl_seconds(conf), work_limit(conf))
      items = payload["items"]

      site.data["orcid_works"] = {
        "id"          => id,
        "profile_url" => "https://orcid.org/#{id}",
        "updated_at"  => payload["fetched_at"],
        "source"      => payload["source"],
        "items"       => items
      }

      Jekyll.logger.info "ORCID:", "已同步 #{items.size} 条成果（来源：#{payload['source']}）"
    rescue StandardError => e
      # 网络/解析异常都不应该让构建失败，回退到 _data/orcid_works.yml 快照。
      Jekyll.logger.warn "ORCID:", "同步失败，沿用 _data/orcid_works.yml 快照：#{e.class}: #{e.message}"
    end

    # ---- 取数 --------------------------------------------------------------

    def load_payload(site, id, ttl, limit)
      cached = read_cache(site, id, ttl)
      return cached if cached

      payload = {
        "id"         => id,
        "fetched_at" => Time.now.utc.iso8601,
        "source"     => "orcid",
        "items"      => build_items(id, fetch_works(id), limit)
      }
      write_cache(site, payload)
      payload
    end

    def fetch_works(id)
      data = fetch_json("#{API_ROOT}/#{id}/works")
      data["group"] || []
    end

    def fetch_work(id, put_code)
      fetch_json("#{API_ROOT}/#{id}/work/#{put_code}")
    end

    def fetch_person(id)
      fetch_json("#{API_ROOT}/#{id}/person")
    end

    def fetch_json(url)
      uri = URI(url)
      request = Net::HTTP::Get.new(uri.request_uri)
      request["Accept"] = "application/json"
      request["User-Agent"] = USER_AGENT
      last_error = nil

      3.times do |attempt|
        begin
          http = Net::HTTP.new(uri.host, uri.port)
          http.use_ssl = true
          http.open_timeout = 8
          http.read_timeout = 20

          response = http.start { |connection| connection.request(request) }
          if response.is_a?(Net::HTTPSuccess)
            return JSON.parse(response.body.to_s.force_encoding("UTF-8"))
          end

          last_error = "HTTP #{response.code}"
        rescue StandardError => e
          last_error = "#{e.class}: #{e.message}"
        end

        sleep(1 + attempt) if attempt < 2
      end

      raise "ORCID API 请求失败（#{url}）：#{last_error}"
    end

    def read_cache(site, id, ttl)
      return nil unless ttl.positive?

      file = cache_path(site, id)
      return nil unless File.file?(file)
      return nil if (Time.now - File.mtime(file)) > ttl

      payload = JSON.parse(File.read(file, encoding: "UTF-8"))
      return nil unless payload.is_a?(Hash) && payload["id"] == id && payload["items"].is_a?(Array)

      payload.merge("source" => "cache")
    rescue StandardError
      nil
    end

    def write_cache(site, payload)
      file = cache_path(site, payload["id"])
      FileUtils.mkdir_p(File.dirname(file))

      tmp = "#{file}.tmp"
      File.write(tmp, JSON.generate(payload), encoding: "UTF-8")
      File.rename(tmp, file)
    rescue StandardError => e
      Jekyll.logger.debug "ORCID:", "缓存写入失败：#{e.message}"
    end

    def cache_path(site, id)
      site.in_source_dir(".jekyll-cache", "orcid-works-#{id}.json")
    end

    # ---- 数据整理 ----------------------------------------------------------

    def build_items(id, groups, limit)
      items = Array(groups).filter_map { |group| parse_summary(group) }
      items = items.sort_by { |item| [item["year"] || 0, item["month"] || 0, item["day"] || 0] }.reverse
      items = items.first(limit) if limit.positive?

      self_names = self_names_for(id)
      items.each do |item|
        item["authors"] = authors_of(id, item.delete("_put_code"), self_names)
      end
      items
    end

    def parse_summary(group)
      summary = Array(group["work-summary"]).first
      return nil if summary.nil?

      title = clean(value_of(summary, "title", "title", "value"))
      return nil if title.nil?

      year, month, day = publication_date(summary)
      doi = doi_of(summary)
      type = clean(summary["type"])

      {
        "title"      => title,
        "type"       => type,
        "type_label" => TYPE_LABELS[type],
        "venue"      => clean(value_of(summary, "journal-title", "value")),
        "year"       => year,
        "month"      => month,
        "day"        => day,
        "date_label" => date_label(year, month, day),
        "doi"        => doi,
        # 优先用 https 的 DOI 解析地址，回退到 ORCID 里填写的链接
        "url"        => doi ? "https://doi.org/#{doi}" : clean(value_of(summary, "url", "value")),
        "_put_code"  => summary["put-code"]
      }
    end

    def authors_of(id, put_code, self_names)
      return nil if put_code.nil?

      record = fetch_work(id, put_code)
      contributors = Array(value_of(record, "contributors", "contributor"))

      authors = contributors.filter_map do |contributor|
        name = clean(value_of(contributor, "credit-name", "value"))
        next if name.nil?

        # 只列作者/发明人，避免把编辑、译者等也算进来
        role = clean(value_of(contributor, "contributor-attributes", "contributor-role"))
        next if role && !%w[author inventor].include?(role.downcase)

        path = clean(value_of(contributor, "contributor-orcid", "path"))
        is_self = path == id || self_names.include?(normalize_name(name))
        { "name" => name, "self" => is_self }
      end

      authors.empty? ? nil : authors
    rescue StandardError => e
      Jekyll.logger.debug "ORCID:", "读取作者失败（put-code #{put_code}）：#{e.message}"
      nil
    end

    # ORCID 档案上本人的名字，用于把作者列表里的自己加粗
    def self_names_for(id)
      name = value_of(fetch_person(id), "name") || {}
      parts = %w(given-names family-name).filter_map { |key| clean(value_of(name, key, "value")) }
      names = [parts.join(" "), clean(value_of(name, "credit-name", "value"))]
      names.filter_map { |entry| normalize_name(entry) }.uniq
    rescue StandardError
      []
    end

    def publication_date(summary)
      date = value_of(summary, "publication-date") || {}
      %w(year month day).map do |part|
        number = value_of(date, part, "value").to_i
        number.positive? ? number : nil
      end
    end

    def doi_of(summary)
      external_ids = Array(value_of(summary, "external-ids", "external-id"))
      match = external_ids.find { |entry| entry["external-id-type"].to_s.casecmp("doi").zero? }
      clean(match && match["external-id-value"])
    end

    def date_label(year, month, day)
      return nil if year.nil?

      label = year.to_s
      label += format("-%02d", month) if month
      label += format("-%02d", day) if month && day
      label
    end

    def value_of(hash, *keys)
      keys.reduce(hash) { |current, key| current.is_a?(Hash) ? current[key] : nil }
    end

    def clean(value)
      text = value.to_s.strip
      text.empty? ? nil : text
    end

    def normalize_name(value)
      name = clean(value)
      name && name.downcase.gsub(/\s+/, " ")
    end

    def normalize_id(raw)
      return nil if raw.nil?

      id = raw.to_s.strip.sub(%r{\Ahttps?://(?:www\.)?orcid\.org/}i, "").delete(" ").upcase
      id.match?(/\A\d{4}-\d{4}-\d{4}-\d{3}[\dX]\z/) ? id : nil
    end

    def work_limit(conf)
      limit = (conf["max_works"] || 50).to_i
      limit.positive? ? limit : 50
    end

    def ttl_seconds(conf)
      hours = conf["cache_ttl_hours"].nil? ? 6.0 : conf["cache_ttl_hours"].to_f
      (hours * 3600).round
    end
  end
end

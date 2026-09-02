# WhiteBoard Pro — production image
#
# Runs under gunicorn, which imports `app` directly as a WSGI callable and
# never executes the `if __name__ == '__main__':` block at the bottom of
# app.py — so app.run(debug=...) there has no effect on this image at all;
# the FLASK_DEBUG env var only matters if someone runs `python app.py` by
# hand instead of using this image.

FROM python:3.12-slim

# Pillow and gpsoauth (Google Keep) both need a couple of native libs to
# build/run; kept to the minimum this app actually touches.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libjpeg62-turbo \
    zlib1g \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Board data, uploaded images, OAuth tokens and the generated session
# secret all live here — must be a volume, or every redeploy wipes them.
RUN mkdir -p /app/data /app/static/uploads
VOLUME ["/app/data", "/app/static/uploads"]

ENV PYTHONUNBUFFERED=1 \
    FLASK_DEBUG=0

EXPOSE 5000
ENV WEB_CONCURRENCY=4

# Shell form so WEB_CONCURRENCY is actually substituted; 4 is a reasonable
# default for a small self-hosted instance — override with
# `docker run -e WEB_CONCURRENCY=N ...`.
CMD gunicorn --bind 0.0.0.0:5000 --workers ${WEB_CONCURRENCY} --timeout 120 app:app

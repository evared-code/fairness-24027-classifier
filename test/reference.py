# Generates reference kappa values with scikit-learn and statsmodels.
# python3 test/reference.py  ->  writes test/reference.json
import json, random, pathlib
from sklearn.metrics import cohen_kappa_score
from statsmodels.stats.inter_rater import fleiss_kappa, aggregate_raters

labels = ["Data", "Cognitive", "Engineering", "None"]
random.seed(7)
a = [random.choice(labels) for _ in range(60)]
b = [x if random.random() < 0.7 else random.choice(labels) for x in a]
c = [x if random.random() < 0.6 else random.choice(labels) for x in a]

cohen = cohen_kappa_score(a, b)
idx = {l: i for i, l in enumerate(labels)}
table, _ = aggregate_raters([[idx[a[i]], idx[b[i]], idx[c[i]]] for i in range(len(a))], n_cat=4)
fleiss = fleiss_kappa(table, method="fleiss")

out = pathlib.Path(__file__).with_name("reference.json")
out.write_text(json.dumps({"a": a, "b": b, "c": c, "cohen": cohen, "fleiss": fleiss}, indent=1))
print("cohen", cohen, "fleiss", fleiss)
